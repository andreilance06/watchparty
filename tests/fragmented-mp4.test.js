const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { box, full } = require("../server/media/containers/iso");
const { u32, u64, checkedReader } = require("../server/media/containers/bytes");
const { inspectIso, isoTimeline } = require("../server/media/containers/iso-metadata");
const { createCaptionSource } = require("../server/media/caption-source");
const { createPreparationBudget } = require("../server/media/preparation-budget");
const { createSourceBridge } = require("../server/source-relay");
const { createApplication } = require("../server/application");
const { CPU_ENCODER } = require("../server/encoders");
const { connectPeer, serveHostFiles } = require("./helpers/peer");

const concat = (...pieces) => Buffer.concat(pieces);

function virtualMovie({ indexed = true, malformed = false, hybrid = false, staleTime = false } = {}) {
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 8);
  const tkhd = Buffer.alloc(80); tkhd.writeUInt32BE(1, 8);
  const mdhd = Buffer.alloc(20); mdhd.writeUInt32BE(1000, 8); mdhd.writeUInt32BE(hybrid ? 2000 : 0, 12);
  const ftyp = box("ftyp", Buffer.from("isom\0\0\0\0isom"));
  const moov = box("moov", concat(full("mvhd", mvhd), box("trak", concat(full("tkhd", tkhd), box("mdia", concat(
    full("mdhd", mdhd), box("minf", box("stbl", full("stsd", concat(u32(1), box("avc1", Buffer.alloc(78)))))))))),
  box("mvex", full("trex", concat(u32(1), u32(1), u32(1000), u32(4), u32(0))))));
  const moof = time => box("moof", box("traf", concat(full("tfhd", concat(u32(1), u32(1000)), 0x20008),
    full("tfdt", u64(time), 0x01000000), full("trun", concat(u32(2), u32(0), u32(4), u32(4)), 0x201))));
  const first = moof(0), last = moof(240000), start = ftyp.length + moov.length;
  const gap = 0x100000000 + 1024, end = start + first.length + gap;
  const mdat = concat(u32(1), Buffer.from("mdat"), u64(gap));
  const tailData = box("mdat", Buffer.alloc(8));
  const tfra = full("tfra", concat(u32(1), u32(0), u32(2), u64(0), u64(start), Buffer.from([1, 1, 1]),
    u64(staleTime ? 1000000 : 240000), u64(malformed ? end + 1 : end), Buffer.from([1, 1, 1])), 0x01000000);
  const mfra = indexed ? box("mfra", concat(tfra, full("mfro", u32(tfra.length + 24)))) : Buffer.alloc(0);
  const pieces = [{ at: 0, bytes: concat(ftyp, moov, first, mdat) }, { at: end, bytes: concat(last, tailData, mfra) }];
  const size = end + last.length + tailData.length + mfra.length, reads = [];
  const source = { size, async read(at, length, signal) {
    signal.throwIfAborted(); reads.push({ at, length });
    assert.ok(!(at >= start + first.length + 16 && at < end), "metadata must skip the 4 GiB media payload");
    const result = Buffer.alloc(length);
    for (const piece of pieces) {
      const from = Math.max(at, piece.at), to = Math.min(at + length, piece.at + piece.bytes.length);
      if (from < to) piece.bytes.copy(result, from - at, from - piece.at, to - piece.at);
    }
    return result;
  } };
  return { source, reads };
}

test("indexed fragmented and hybrid MP4 timelines use metadata at 64-bit offsets", async () => {
  for (const hybrid of [false, true]) {
    const movie = virtualMovie({ hybrid }), reader = checkedReader(movie.source, new AbortController().signal);
    const metadata = await inspectIso(reader), timeline = await isoTimeline(metadata, reader);
    assert.equal(metadata.fragmented, true);
    assert.equal(timeline.indexed, true);
    assert.equal(timeline.durationEnd, 242);
    assert.deepEqual(timeline.inputArgs, ["-use_mfra_for", "pts"]);
    assert.ok(movie.reads.reduce((sum, read) => sum + read.length, 0) < 4096);
    const before = movie.reads.length;
    const source = createCaptionSource({ ...movie.source, isoMetadata: () => metadata }, new AbortController().signal);
    assert.deepEqual((await source.discover()).tracks, []);
    assert.equal(movie.reads.length, before + 1, "no-subtitle discovery only reads its signature");
  }
});

test("missing and malformed fragment indexes use complete structural metadata, never media payloads", async () => {
  for (const options of [{ indexed: false }, { malformed: true }, { staleTime: true }]) {
    const movie = virtualMovie(options), reader = checkedReader(movie.source, new AbortController().signal);
    const metadata = await inspectIso(reader), timeline = await isoTimeline(metadata, reader);
    assert.equal(timeline.indexed, false);
    assert.equal(timeline.durationEnd, 242);
    assert.deepEqual(timeline.inputArgs, []);
  }
});

test("preparation leases enforce an aggregate read budget and revoke URLs on close", async t => {
  const bridge = createSourceBridge({ sourceChunkBytes: 1024, sourceMaxReads: 1 });
  await bridge.listen(); t.after(() => bridge.close());
  let supplied = 0;
  const source = bridge.register({ files: new Map([["video", { size: 8192 }]]), read: async (_id, _at, length) => {
    supplied += length; return Buffer.alloc(length);
  } });
  t.after(() => source.close());
  const budget = createPreparationBudget({ mediaPreparationBytes: 2048 }); t.after(() => budget.finish());
  const lease = source.lease("video", budget);
  await assert.rejects(async () => { const response = await fetch(lease.url); await response.arrayBuffer(); });
  assert.equal(supplied, 2048);
  assert.equal(budget.error.code, "MEDIA_PREPARATION_LIMIT");
  assert.equal((await fetch(lease.url)).status, 404);
  lease.close();
});

test("preparation deadlines cancel pending provider reads and parent cancellation propagates", async t => {
  const bridge = createSourceBridge({ sourceChunkBytes: 1024, sourceMaxReads: 1 });
  await bridge.listen(); t.after(() => bridge.close());
  let cancelled = false;
  const source = bridge.register({ files: new Map([["video", { size: 4096 }]]), read: (_id, _at, _length, signal) => new Promise((resolve, reject) => {
    const abort = () => { cancelled = true; reject(new Error("cancelled")); };
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
  }) });
  t.after(() => source.close());
  const budget = createPreparationBudget({ mediaPreparationMs: 500 });
  const lease = source.lease("video", budget);
  await assert.rejects(async () => { const response = await fetch(lease.url); await response.arrayBuffer(); });
  assert.equal(cancelled, true); assert.equal(budget.error.code, "MEDIA_PREPARATION_LIMIT");
  budget.finish(); lease.close();
  const parent = new AbortController(), next = createPreparationBudget({}, parent.signal);
  parent.abort(new Error("replaced"));
  assert.throws(() => next.consume(1), /replaced/); next.finish();
});

function fixture(t, flags) {
  const ffmpeg = require("ffmpeg-static");
  if (!ffmpeg || !fs.existsSync(ffmpeg)) { t.skip("FFmpeg is unavailable"); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "watchparty-test-mp4-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("watchparty-test-mp4-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const filename = path.join(directory, "recording.mp4");
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "60", "-c:v", "libx264", "-preset", "ultrafast",
    "-g", "48", "-c:a", "libopus", "-movflags", flags, filename], { windowsHide: true, timeout: 20000 });
  return { ffmpeg, bytes: fs.readFileSync(filename) };
}

test("hybrid MP4 retains its initial samples and complete fragmented duration", async t => {
  const file = fixture(t, "+frag_keyframe"); if (!file) return;
  const reads = [], source = { size: file.bytes.length, read: async (at, length) => {
    reads.push({ at, length }); return file.bytes.subarray(at, at + length);
  } };
  const reader = checkedReader(source, new AbortController().signal), metadata = await inspectIso(reader);
  const timeline = await isoTimeline(metadata, reader);
  assert.equal(metadata.fragmented, true); assert.equal(timeline.indexed, true);
  assert.ok(Math.abs(timeline.durationEnd - 60) < 0.04);
  assert.ok(reads.reduce((sum, read) => sum + read.length, 0) < 64 * 1024);
});

test("relay preparation limits produce actionable errors without publishing a partial timeline", async t => {
  const file = fixture(t, "+frag_keyframe+empty_moov+skip_trailer"); if (!file) return;
  const app = createApplication({ config: { port: 0, mediaPreparationBytes: 8192 }, encoderPromise: Promise.resolve(CPU_ENCODER) });
  const address = await app.listen(); t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`, host = await connectPeer(base.replace("http", "ws"), "Provider");
  const relay = await serveHostFiles(host, base, { name: "recording.mp4", bytes: file.bytes });
  const error = await host.next("media-error");
  assert.equal(error.code, "MEDIA_PREPARATION_LIMIT"); assert.match(error.message, /[Rr]emux/);
  assert.equal(app.state.mediaReady, false); assert.equal(app.state.mediaDuration, 0);
  assert.ok(relay.reads.reduce((sum, read) => sum + read.length, 0) <= 8192);
});

test("unindexed encoder startup deadlines stop before retrying another encoder", async t => {
  const { EventEmitter } = require("node:events");
  const { createSegmentService } = require("../server/media/segments");
  const { createSession } = require("../server/state");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "watchparty-hls-mp4-"));
  const state = Object.assign(createSession(), { hlsDirectory: directory, mediaPath: "http://127.0.0.1/unindexed.mp4",
    mediaVersion: 1, mediaReady: true, mediaDuration: 60, mediaInfo: { fps: 30, container: { fragmented: true, indexed: false } } });
  const messages = []; let attempts = 0;
  const service = createSegmentService({ state, config: { segmentSeconds: 2, maxSegmentsAhead: 2, mediaPreparationMs: 50 },
    encoderPromise: Promise.resolve({ name: "hardware-test", input: [], args: [] }), broadcast: message => messages.push(message),
    spawnEncoder() {
      attempts++;
      const process = new EventEmitter(); process.stderr = new EventEmitter();
      process.kill = () => { queueMicrotask(() => process.emit("close", 1)); };
      return process;
    } });
  t.after(async () => {
    await service.cancel();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("watchparty-hls-mp4-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await assert.rejects(service.ensure(0), error => error.code === "MEDIA_PREPARATION_LIMIT");
  assert.equal(attempts, 1);
  assert.equal(messages.find(message => message.type === "media-error").code, "MEDIA_PREPARATION_LIMIT");
});

test("fragmented MP4 relay preparation preserves the full timeline and seeks without rescanning", async t => {
  const file = fixture(t, "+frag_keyframe+empty_moov"); if (!file) return;
  const app = createApplication({ config: { port: 0 }, encoderPromise: Promise.resolve(CPU_ENCODER) });
  const address = await app.listen(); t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`, host = await connectPeer(base.replace("http", "ws"), "Provider");
  const relay = await serveHostFiles(host, base, { name: "recording.mp4", bytes: file.bytes });
  const ready = await host.next("session-state", state => state.hasVideo);
  assert.ok(Math.abs(ready.duration - 60) < 0.04, `duration: ${ready.duration}`);
  assert.deepEqual(ready.mediaInfo.container, { family: "iso-bmff", fragmented: true, indexed: true });
  assert.equal(ready.mediaInfo.audioCodec, "opus");
  assert.deepEqual(app.state.mediaInputArgs, ["-use_mfra_for", "pts"]);
  const total = () => relay.reads.reduce((sum, read) => sum + read.length, 0);
  assert.ok(total() < 8 * 1024 * 1024, `${total()} preparation bytes`);
  assert.equal(ready.captions.length, 0);
  const captionReads = relay.reads.filter(read => read.type === "source-read-batch").length;
  for (const time of [0, 30, 56]) {
    app.state.playback = { paused: true, time, rate: 1, updatedAt: Date.now() };
    if (time) app.media.restartStream();
    const before = total(), index = Math.floor(time / app.media.segmentSeconds());
    const url = `${base}/hls/segment_${String(index).padStart(6, "0")}.ts?s=${ready.sessionId}&v=${ready.mediaVersion}&g=${app.state.streamGeneration}`;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    const output = execFileSync(file.ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-t", "0.25", "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"],
      { input: bytes, windowsHide: true, timeout: 10000 });
    assert.equal(output.length, 0);
    assert.ok(total() - before < 16 * 1024 * 1024);
  }
  assert.equal(relay.reads.filter(read => read.type === "source-read-batch").length, captionReads, "caption discovery never walks the fragments");
});
