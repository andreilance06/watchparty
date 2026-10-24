const test = require("node:test");
const assert = require("node:assert/strict");
const { createSession } = require("../server/state");
const { createThumbnails, createThumbnailQueue } = require("../server/media/thumbnails");
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(options = {}) {
  const state = createSession();
  Object.assign(state, { mediaPath: "internal-source", mediaReady: true, mediaVersion: 1, mediaDuration: 120 });
  let clock = 0;
  const calls = [];
  const preview = createThumbnails({ state, config: {}, queue: createThumbnailQueue(), now: () => clock,
    capture: async input => { calls.push(input); return Buffer.from("frame"); }, ...options });
  return { state, preview, calls, advance: ms => { clock += ms; } };
}

test("previews capture the shared clock, refresh no faster than thirty seconds, and skip unchanged paused frames", async () => {
  const f = fixture();
  f.state.playback.time = 12;
  f.preview.refresh(); f.preview.refresh(); await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].time, 12);
  f.advance(29999); f.state.playback.time = 20; f.preview.refresh(); await flush();
  assert.equal(f.calls.length, 1);
  f.advance(1); f.preview.refresh(); await flush();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].time, 20);
  f.advance(30000); f.preview.refresh(); await flush();
  assert.equal(f.calls.length, 2, "unchanged paused frames reuse their image");
  f.state.playback.paused = false; f.state.playback.updatedAt = Date.now();
  f.preview.refresh(); await flush();
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls[2].time >= 20 && f.calls[2].time < 21);
  assert.equal(f.preview.get().revision, 3);
  f.preview.reset();
});

test("all rooms share one worker, repeated requests coalesce, and cancelled queued work never starts", async () => {
  const queue = createThumbnailQueue(), a = Symbol(), b = Symbol(), c = Symbol();
  const started = [];
  let release;
  queue.enqueue(a, async () => { started.push("a"); await new Promise(resolve => { release = resolve; }); });
  queue.enqueue(a, async () => started.push("duplicate"));
  queue.enqueue(b, async () => started.push("b"));
  queue.enqueue(c, async () => started.push("c"));
  queue.cancel(c);
  await flush();
  assert.deepEqual(started, ["a"]);
  release(); await flush();
  assert.deepEqual(started, ["a", "b"]);
});

test("source replacement cancels active extraction and prevents late images from leaking into the new source", async () => {
  let release, oldSignal;
  const f = fixture({ capture: ({ signal }) => { oldSignal = signal; return new Promise(resolve => { release = resolve; }); } });
  f.preview.refresh(); await flush();
  f.preview.reset(); f.state.mediaVersion++;
  assert.equal(oldSignal.aborted, true);
  release(Buffer.from("obsolete frame")); await flush();
  assert.equal(f.preview.get(), null);
  f.state.mediaReady = false; f.preview.refresh(); await flush();
  assert.equal(f.preview.get(), null);
});

test("failed refreshes keep the previous frame, apply a retry interval, and close bounded read leases", async () => {
  let calls = 0, closed = 0, budget;
  const f = fixture({ capture: async () => { if (++calls > 1) throw new Error("Decoder unavailable"); return Buffer.from("first frame"); } });
  f.state.openMediaLease = input => { budget = input; return { url: "leased-source", close() { closed++; } }; };
  f.preview.refresh(); await flush();
  const initial = f.preview.get();
  assert.equal(closed, 1);
  assert.equal(budget.signal.aborted, true);
  f.advance(30000); f.state.playback.time = 10;
  f.preview.refresh(); await flush();
  assert.equal(closed, 2);
  assert.equal(f.preview.get(), initial);
  f.preview.refresh(); await flush(); assert.equal(calls, 2);
  f.advance(30000); f.preview.refresh(); await flush(); assert.equal(calls, 3);
  f.preview.reset(); assert.equal(f.preview.get(), null);
});

test("thumbnail reads are bounded and oversized output cannot replace a valid frame", async () => {
  const f = fixture({ capture: async () => Buffer.alloc(256 * 1024 + 1) });
  f.preview.refresh(); await flush(); assert.equal(f.preview.get(), null);
  f.advance(30000);
  let signal;
  f.state.openMediaLease = budget => { signal = budget.signal; budget.consume(16 * 1024 * 1024 + 1); };
  f.preview.refresh(); await flush();
  assert.equal(signal.aborted, true);
  assert.equal(f.preview.get(), null);
  assert.equal(f.state.mediaReady, true, "preview errors do not change playback readiness");
});
