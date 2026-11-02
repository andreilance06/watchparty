const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrowserDouble } = require("./helpers/browser");

const hdr = { hdr: true, mime: "video/mp4", videoCodec: "hevc", videoCodecString: "hvc1.2.4.L153.B0", bitDepth: 10,
  pixelFormat: "yuv420p10le", colorTransfer: "smpte2084", colorPrimaries: "bt2020", width: 3840, height: 2160,
  bitrate: 12000000, fps: 24, hasAudio: true, audioCodec: "aac", channels: 6, sampleRate: 48000 };
const flush = () => new Promise(resolve => setImmediate(resolve));

function browser({ display = true, assess } = {}) {
  const b = createBrowserDouble();
  const queries = new Map();
  b.context.matchMedia = query => {
    if (!queries.has(query)) queries.set(query, { matches: display, addEventListener(_type, fn) { this.changed = fn; } });
    return queries.get(query);
  };
  b.context.navigator = { mediaCapabilities: { decodingInfo: assess || (async configuration => ({ supported: true, smooth: true, configuration })) } };
  const create = b.document.createElement;
  b.document.createElement = tag => { const element = create(tag); if (tag === "video") element.canPlayType = () => "probably"; return element; };
  return { b, queries };
}

test("HDR requires both an HDR display and positive assessment of the actual native format", async () => {
  let checked;
  const capable = browser({ assess: async configuration => { checked = configuration; return { supported: true, smooth: true, configuration }; } });
  const { choosePlayback } = await capable.b.load("js/player/playback.js");
  assert.equal(await choosePlayback(hdr), "native");
  assert.equal(checked.video.transferFunction, "pq"); assert.equal(checked.video.colorGamut, "rec2020");
  assert.equal(checked.audio.channels, "6"); assert.match(checked.video.contentType, /hvc1\.2\.4\.L153\.B0/);
  assert.equal(await choosePlayback({ ...hdr, colorTransfer: "arib-std-b67" }), "native");
  assert.equal(checked.video.transferFunction, "hlg");
  const sdr = browser({ display: false, assess: () => { throw Error("must not assess an SDR display"); } });
  assert.equal(await (await sdr.b.load("js/player/playback.js")).choosePlayback(hdr), "compatibility");
});

test("missing, ignored, failed, and timed out HDR capabilities conservatively select SDR", async () => {
  for (const assess of [async () => ({ supported: true, smooth: true }), async configuration => ({ supported: true, smooth: false, configuration }),
    async () => { throw Error("unsupported"); }]) {
    const { b } = browser({ assess });
    assert.equal(await (await b.load("js/player/playback.js")).choosePlayback(hdr), "compatibility");
  }
  const { b } = browser({ assess: () => new Promise(() => {}) });
  const { choosePlayback } = await b.load("js/player/playback.js");
  const pending = choosePlayback(hdr); await flush(); b.runTimers(500);
  assert.equal(await pending, "compatibility");
  delete b.context.navigator.mediaCapabilities;
  assert.equal(await choosePlayback(hdr), "compatibility");
  assert.equal(await choosePlayback({ ...hdr, videoCodecString: "" }), "compatibility");
});

test("unverified canvas HDR, dynamic HDR, and unknown color metadata use SDR compatibility", async () => {
  const { b } = browser();
  const { choosePlayback } = await b.load("js/player/playback.js");
  for (const change of [{ mime: "video/x-matroska" }, { colorTransfer: "" }, { colorPrimaries: "" }, { dynamicHdr: true }]) {
    assert.equal(await choosePlayback({ ...hdr, ...change }), "compatibility");
  }
  const create = b.document.createElement;
  b.document.createElement = tag => { const element = create(tag); if (tag === "video") element.canPlayType = () => ""; return element; };
  assert.equal(await choosePlayback(hdr), "compatibility");
});

test("display loss switches only the affected viewer to SDR and cannot invoke implicit WASM HDR", async () => {
  async function viewer() {
    const { b, queries } = browser();
    const { getElements } = await b.load("js/dom.js");
    const { createPlayer } = await b.load("js/player/controller.js");
    const elements = getElements(), sent = [], state = { role: "viewer", clientId: "viewer", mediaVersion: 0 };
    elements.video.readyState = 4;
    const player = createPlayer({ elements, state, send: message => sent.push(message), report() {}, files: { setRole() {}, chooseVideo() {}, chooseCaptions() {} } });
    player.applySessionState({ mediaVersion: 1, playbackRevision: 1, hasVideo: true, paused: true, time: 17, playbackRate: 1.25,
      originalUrl: "/original", compatibilityUrl: "/hls/master.m3u8", mediaInfo: hdr, captions: [] });
    await flush(); await flush();
    return { b, queries, state, elements, sent };
  }
  const first = await viewer(), second = await viewer();
  assert.equal(first.elements.video.getAttribute("engine"), "native");
  for (const query of first.queries.values()) query.matches = false;
  [...first.queries.values()][0].changed(); await flush(); await flush();
  assert.equal(first.sent.filter(message => message.type === "compatibility-request").length, 1);
  assert.equal(first.sent.filter(message => message.type === "video-state").length, 0);
  assert.equal(second.sent.filter(message => message.type === "compatibility-request").length, 0);
  assert.equal(second.state.activeMediaUrl, "/original");
});

test("foreground return reassesses HDR support", async () => {
  const { b } = browser();
  let calls = 0;
  b.context.navigator.mediaCapabilities.decodingInfo = async configuration => ({ supported: ++calls === 1, smooth: true, configuration });
  const { getElements } = await b.load("js/dom.js");
  const { createPlayer } = await b.load("js/player/controller.js");
  const sent = [], elements = getElements(); elements.video.readyState = 4;
  const player = createPlayer({ elements, state: { role: "viewer", mediaVersion: 0 }, send: message => sent.push(message), report() {},
    files: { setRole() {}, chooseVideo() {}, chooseCaptions() {} } });
  player.applySessionState({ mediaVersion: 1, hasVideo: true, paused: true, time: 10, playbackRate: 1,
    originalUrl: "/original", compatibilityUrl: "/hls/master.m3u8", mediaInfo: hdr, captions: [] });
  await flush();
  b.document.dispatch("visibilitychange"); await flush();
  assert.equal(sent.filter(message => message.type === "compatibility-request").length, 1);
});

test("manual Original selection reassesses HDR, and a decoder failure from Original falls back locally", async () => {
  const { qualityOptions, resolveQuality } = require("../server/media/quality");
  const { b, queries } = browser();
  let supported = true, assessments = 0;
  b.context.navigator.mediaCapabilities.decodingInfo = async configuration => { assessments++; return { supported, smooth: true, configuration }; };
  const { getElements } = await b.load("js/dom.js");
  const { createPlayer } = await b.load("js/player/controller.js");
  const elements = getElements(), video = elements.video, sent = [], state = { role: "viewer", clientId: "viewer", mediaVersion: 0 };
  video.readyState = 4;
  const qualityList = b.document.createElement("div"); qualityList.className = "movi-quality-list"; video.shadowRoot.appendChild(qualityList);
  const player = createPlayer({ elements, state, send: message => { sent.push(message); return true; }, report() {},
    files: { setRole() {}, chooseVideo() {}, chooseCaptions() {} } });
  const snapshot = { mediaVersion: 1, playbackRevision: 1, hasVideo: true, paused: true, time: 17, playbackRate: 1.25, duration: 200,
    originalUrl: "/original", compatibilityUrl: "/hls/master.m3u8", mediaInfo: { ...hdr, qualityOptions: qualityOptions(hdr), bitrateLimits: [3000000] }, captions: [] };
  player.applySessionState(snapshot); await flush(); await flush();
  const change = value => { const select = qualityList.querySelector("select"); select.value = value; select.dispatch("change"); };
  change("720");
  const request = sent.filter(message => message.type === "compatibility-request").at(-1);
  player.applyCompatibility({ ...snapshot, type: "compatibility-ready", requestId: request.requestId,
    rendition: resolveQuality(hdr, "720"), segmentSeconds: 2, url: "/hls/sdr/master.m3u8" });
  await flush(); await flush();
  assert.equal(state.activeMediaUrl, "/hls/sdr/master.m3u8");
  const before = assessments; supported = false;
  change("source"); await flush(); await flush();
  assert.ok(assessments > before); assert.equal(state.activeMediaUrl, "/hls/sdr/master.m3u8");
  const compatible = sent.filter(message => message.type === "compatibility-request").at(-1);
  assert.equal(compatible.quality, "source"); assert.equal(compatible.bitrate, "source");
  player.applyCompatibility({ ...snapshot, type: "compatibility-ready", requestId: compatible.requestId,
    rendition: resolveQuality(hdr, "source", "source"), segmentSeconds: 2, url: "/hls/source/master.m3u8" });
  await flush(); await flush();
  assert.equal(video.watchpartyQualityMetrics.preferences.quality, "source");
  assert.equal(video.watchpartyQualityMetrics.preferences.bitrate, "source");
  supported = true;
  [...queries.values()][0].changed(); await flush();
  change("source"); await flush(); await flush();
  assert.equal(state.activeMediaUrl, "/original"); assert.equal(video.getAttribute("engine"), "native");
  state.sourceSwitching = false;
  video.dispatch("error", { detail: { message: "decoder failed" } });
  assert.equal(sent.filter(message => message.type === "compatibility-request").length, 3);
  assert.equal(sent.filter(message => message.type === "video-state").length, 0);
});
