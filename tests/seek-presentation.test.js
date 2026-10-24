const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrowserDouble } = require("./helpers/browser");

async function harness() {
  const b = createBrowserDouble(), video = b.elements.get("video");
  const native = b.document.createElement("video");
  Object.assign(native, { currentTime: 12, readyState: 4, videoWidth: 3840, videoHeight: 2160, seeking: false });
  const callbacks = new Map(); let nextCallback = 0, paints = 0, captures = 0, overlay, complete = false, timedOut = 0;
  native.requestVideoFrameCallback = callback => { callbacks.set(++nextCallback, callback); return nextCallback; };
  native.cancelVideoFrameCallback = id => callbacks.delete(id);
  const create = b.document.createElement;
  b.document.createElement = tag => { const element = create(tag); if (tag === "canvas") element.getContext = () => ({ drawImage() { captures++; } }); return element; };
  const oldPlayer = { getHLSVideoElement: () => native, streamWrapper: { renderFrame() { paints++; } } };
  video.player = oldPlayer;
  let backendDuration = 100;
  Object.defineProperty(video, "duration", { configurable: true, get: () => backendDuration });
  Object.defineProperty(video, "currentTime", { configurable: true, get: () => native.currentTime });
  video._uiCurrentTime = () => native.currentTime;
  video._armUiSeekTarget = time => { native.currentTime = time; };
  video.showOverlay = spec => { overlay = spec; };
  video.hideOverlay = () => { overlay = undefined; };
  video.updateTimeDisplay = () => { video.clock = video._uiCurrentTime(); video.total = video.duration; };
  video.updateProgressBar = () => { video.progress = video._uiCurrentTime() / video.duration; };
  video.updateSeekAria = () => { video.ariaTime = video._uiCurrentTime(); };
  video.dispose = () => { video.clock = 0; video.total = 0; };
  const { createSeekPresentation } = await b.load("js/player/seek-presentation.js");
  const presentation = createSeekPresentation({ video, snapshot: () => ({ duration: 100, mediaInfo: { fps: 30 } }),
    settled: () => complete, canBeginLocal: () => true, onTimeout: () => timedOut++ });
  function frame(time) { const work = [...callbacks.values()]; callbacks.clear(); work.forEach(callback => callback(0, { mediaTime: time })); }
  return { b, video, native, oldPlayer, presentation, frame, callbacks, captures: () => captures, paints: () => paints,
    overlay: () => overlay, setDuration: value => { backendDuration = value; }, settle: () => { complete = true; }, timedOut: () => timedOut };
}

test("a replacement retains a bounded frame, target, duration, progress, and accessible seek position", async () => {
  const h = await harness();
  h.presentation.begin(60, 100, true);
  h.setDuration(0); h.native.currentTime = 0;
  h.video.updateTimeDisplay(); h.video.updateProgressBar(); h.video.updateSeekAria();
  assert.equal(h.video.clock, 60); assert.equal(h.video.total, 100); assert.equal(h.video.progress, 0.6); assert.equal(h.video.ariaTime, 60);
  assert.equal(h.video.currentTime, 0, "the underlying clock remains truthful for synchronization");
  h.video.dispose();
  assert.equal(h.video.clock, 60, "synchronous source disposal cannot paint zero labels");
  assert.equal(h.video.total, 100);
  assert.equal(h.overlay().content.width, 1920); assert.equal(h.overlay().content.height, 1080);
  assert.equal(h.overlay().interactive, false);
  h.presentation.update(); h.frame(60); h.b.runFrame();
  assert.equal(h.presentation.active(), true, "retired player readiness cannot reveal the replacement");
  h.video.player = { ...h.oldPlayer }; h.native.currentTime = 60;
  h.presentation.update(); h.frame(60); h.b.runFrame();
  assert.equal(h.presentation.active(), true, "a decoded frame alone cannot bypass transport restoration");
  h.settle(); h.presentation.update(); h.b.runFrame();
  assert.equal(h.presentation.active(), false); assert.equal(h.overlay(), undefined);
});

test("rapid and zero-position seeks keep one snapshot and ignore superseded callbacks", async () => {
  const h = await harness();
  h.presentation.begin(60, 100);
  const oldCallback = [...h.callbacks.values()][0];
  h.presentation.begin(0, 100);
  h.native.currentTime = 0;
  h.video.updateTimeDisplay(); assert.equal(h.video.clock, 0, "zero is a valid requested position");
  assert.equal(h.captures(), 1);
  oldCallback(0, { mediaTime: 60 }); h.b.runFrame();
  assert.equal(h.presentation.active(), true);
  h.settle(); h.presentation.update(); h.frame(0); h.b.runFrame();
  assert.equal(h.presentation.active(), false);
});

test("an intermediate frame immediately rearms observation and an unchanged position needs no hold", async () => {
  const h = await harness();
  h.presentation.begin(12, 100);
  assert.equal(h.presentation.active(), false);
  h.presentation.begin(44, 100);
  h.frame(20);
  assert.equal(h.callbacks.size, 1, "observe the next frame without waiting for a polling tick");
  h.native.currentTime = 44; h.settle(); h.frame(44); h.b.runFrame();
  assert.equal(h.presentation.active(), false);
});

test("paused HLS can repaint its target even when its frame callback already fired", async () => {
  const h = await harness();
  h.presentation.begin(44, 100, true);
  h.video.player = { ...h.oldPlayer }; h.native.currentTime = 44; h.native.paused = true;
  h.settle(); h.presentation.update(); h.b.runFrame();
  assert.ok(h.paints() > 0); assert.equal(h.presentation.active(), false);
});

test("paused native playback releases a decoded target when rapid seeks precede callback registration", async () => {
  const h = await harness();
  h.video.player = { getVideoElement: () => h.native };
  h.presentation.begin(44, 100);
  h.frame(12); // A callback for an earlier frame can precede the latest seek.
  h.native.currentTime = 44; h.native.seeking = true; h.settle();
  h.presentation.update(); h.b.runFrame();
  assert.equal(h.presentation.active(), true);
  h.native.seeking = false;
  h.presentation.update(); h.b.runFrame();
  assert.equal(h.presentation.active(), false);
});

test("intent is captured before the UI starts seeking, and failed capture still preserves the clock", async () => {
  const h = await harness();
  h.video._armUiSeekTarget(40);
  assert.equal(h.captures(), 1); assert.equal(h.video.clock, 40);
  h.presentation.clear();
  h.b.document.createElement = () => { throw Error("canvas unavailable"); };
  h.presentation.begin(80, 100);
  assert.equal(h.video.clock, 80); assert.equal(h.overlay(), undefined);
});

test("source removal, terminal failure, and timeout release the frame and restore original UI hooks", async () => {
  const h = await harness();
  h.presentation.begin(40, 100); h.presentation.clear();
  assert.equal(h.presentation.active(), false); assert.equal(h.overlay(), undefined); assert.equal(h.video.clock, 12);
  h.presentation.begin(50, 100); h.b.runTimers(10000);
  assert.equal(h.presentation.active(), false); assert.equal(h.timedOut(), 1);
  h.presentation.dispose(); h.setDuration(90);
  assert.equal(h.video.duration, 90); assert.equal(h.video._uiCurrentTime(), 12);
});
