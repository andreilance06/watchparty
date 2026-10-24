const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrowserDouble } = require("./helpers/browser");
const { qualityOptions, resolveQuality } = require("../server/media/quality");
const flush = () => new Promise(resolve => setImmediate(resolve));
const gpu = "h264_nvenc: hardware decode + GPU scale + hardware encode";
const cpu = "CPU fallback (libx264)";

async function harness({ supported = false, quality = true, role = "host" } = {}) {
  const b = createBrowserDouble();
  const { getElements } = await b.load("js/dom.js");
  const { createPlayer } = await b.load("js/player/controller.js");
  const elements = getElements(), video = elements.video, sent = [];
  video.readyState = 4;
  const create = b.document.createElement;
  b.document.createElement = tag => { const node = create(tag); if (tag === "video") node.canPlayType = () => supported ? "probably" : ""; return node; };
  const menu = create("div"); menu.className = "movi-quality-list"; video.shadowRoot.appendChild(menu);
  const state = { role, clientId: role, mediaVersion: 0 };
  const player = createPlayer({ elements, state, send: message => { sent.push(message); return true; }, report() {},
    files: { setRole() {}, chooseVideo() {}, chooseCaptions() {} } });
  let snapshot = { sessionId: "source-session", mediaVersion: 1, playbackRevision: 1, streamGeneration: 0,
    hasVideo: true, paused: true, time: 17, playbackRate: 1.25, duration: 200,
    originalUrl: "/media/original?s=source-session&v=1", compatibilityUrl: "/hls/master.m3u8?s=source-session&v=1&g=0", captions: [],
    mediaInfo: { mime: "video/mp4", videoCodec: "h264", bitDepth: 8, width: 1920, height: 1080, hasAudio: false,
      ...(quality ? { qualityOptions: qualityOptions({ width: 1920, height: 1080 }), bitrateLimits: [3000000, 1500000, 750000] } : {}) } };
  player.applySessionState(snapshot); await flush();
  const requests = () => sent.filter(message => message.type === "compatibility-request");
  function response(values = {}) {
    const request = requests().at(-1);
    const rendition = quality ? resolveQuality(snapshot.mediaInfo, request.quality, request.bitrate) : null;
    return { ...snapshot, type: "compatibility-ready", requestId: request.requestId, segmentSeconds: 2,
      ...(rendition ? { rendition, renditionGeneration: 0 } : {}),
      url: `${snapshot.compatibilityUrl}${rendition ? `&r=${rendition.id}&rg=0` : ""}`, ...values };
  }
  const info = (encoder = gpu, renditionId = quality ? response().rendition.id : undefined, values = {}) => ({
    type: "transcode-info", sessionId: snapshot.sessionId, mediaVersion: snapshot.mediaVersion, streamGeneration: snapshot.streamGeneration,
    ...(renditionId ? { renditionId, renditionGeneration: 0 } : {}), encoder, ...values });
  const reply = async values => { const message = response(values); player.applyCompatibility(message); await flush(); await flush(); return message; };
  const apply = async values => { snapshot = { ...snapshot, ...values }; player.applySessionState(snapshot); await flush(); };
  const change = value => { const select = menu.querySelector("select"); select.value = value; select.dispatch("change"); };
  return { b, video, elements, state, player, sent, requests, response, info, reply, apply, change, snapshot: () => snapshot };
}

test("startup retains a pipeline announced while the selected fragment is still being prefetched", async () => {
  const h = await harness();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  h.b.context.fetch = async () => {
    h.player.updateEncoder(h.info());
    await gate;
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) };
  };
  h.player.applyCompatibility(h.response()); await flush();
  assert.equal(h.state.activeEncoder, "Direct playback", "pending pipeline does not replace an active source label");
  release(); await flush(); await flush();
  assert.equal(h.state.activeEncoder, gpu);
  for (const event of ["loadedmetadata", "canplay", "loadeddata", "playing"]) h.video.dispatch(event);
  h.b.runTimers(100); await flush();
  assert.equal(h.elements.syncStatus.textContent, `You control playback • ${gpu}`);
  await h.apply({ syncMode: "pause", paused: true });
  assert.equal(h.elements.syncStatus.textContent, `You control playback • ${gpu}`);
});

test("paused and playing seeks preserve details through prefetch, replacement, and later transport updates", async () => {
  for (const paused of [true, false]) {
    const h = await harness();
    await h.reply({ transcodeInfo: h.info() });
    await h.apply({ paused, time: 60, syncMode: "seek", playbackRevision: 2, streamGeneration: 1,
      compatibilityUrl: "/hls/master.m3u8?s=source-session&v=1&g=1" });
    assert.equal(h.state.activeEncoder, gpu, "seek retains the last confirmed pipeline");
    h.b.context.fetch = async () => {
      h.player.updateEncoder(h.info(cpu, undefined, { renditionGeneration: 1 }));
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) };
    };
    await h.reply({ renditionGeneration: 1, transcodeInfo: h.info(gpu, undefined, { renditionGeneration: 1 }) });
    h.video.dispatch("canplay"); h.video.dispatch("loadeddata"); h.b.runTimers(100); await flush();
    assert.equal(h.state.activeEncoder, cpu);
    assert.equal(h.elements.syncStatus.textContent, `You control playback • ${cpu}`);
    await h.apply({ syncMode: "pause", paused: true });
    assert.equal(h.elements.syncStatus.textContent, `You control playback • ${cpu}`);
    h.player.updateEncoder(h.info("obsolete", undefined, { streamGeneration: 0, renditionGeneration: 0 }));
    h.player.updateEncoder(h.info("obsolete", undefined, { renditionGeneration: 0 }));
    assert.equal(h.state.activeEncoder, cpu);
  }
});

test("cached compatibility negotiation restores the pipeline without a fresh announcement", async () => {
  const h = await harness({ role: "viewer" });
  await h.reply({ transcodeInfo: h.info() });
  h.video.dispatch("canplay"); h.b.runTimers(100); await flush();
  assert.equal(h.state.activeEncoder, gpu);
  assert.equal(h.elements.syncStatus.textContent, `Paused • ${gpu}`);
  await h.apply({ syncMode: "play", paused: false });
  assert.equal(h.elements.syncStatus.textContent, `Synchronized with host • ${gpu}`);
  h.player.applyRole("host");
  assert.equal(h.elements.syncStatus.textContent, `You control playback • ${gpu}`);
});

test("quality switches keep the old pipeline until activation and cached selections restore their own details", async () => {
  const h = await harness({ supported: true });
  h.change("720"); await h.reply({ transcodeInfo: h.info() });
  const firstId = h.response().rendition.id;
  h.change("480");
  const secondId = h.response().rendition.id;
  h.player.updateEncoder(h.info(cpu, secondId));
  assert.equal(h.state.activeEncoder, gpu, "pending rendition cannot replace the active pipeline");
  await h.reply();
  assert.equal(h.state.activeEncoder, cpu);
  h.player.updateEncoder(h.info("unrelated pipeline", firstId));
  assert.equal(h.state.activeEncoder, cpu);
  h.change("source");
  assert.equal(h.state.activeEncoder, "Direct playback");
  h.player.updateEncoder(h.info("unused hardware", secondId));
  assert.equal(h.state.activeEncoder, "Direct playback");
  h.change("720"); await h.reply({ transcodeInfo: h.info(gpu, firstId) });
  assert.equal(h.state.activeEncoder, gpu);
});

test("source changes and obsolete messages cannot leak a previous pipeline into a new source", async () => {
  const h = await harness();
  const oldInfo = h.info(); await h.reply({ transcodeInfo: oldInfo });
  await h.apply({ processing: true, hasVideo: false, mediaVersion: 2 });
  assert.equal(h.state.activeEncoder, "");
  h.player.updateEncoder(oldInfo);
  await h.apply({ processing: false, hasVideo: true, originalUrl: "/media/original?v=2", compatibilityUrl: "/hls/master.m3u8?v=2" });
  await h.reply();
  h.player.updateEncoder(oldInfo);
  h.player.updateEncoder(h.info("another session", undefined, { sessionId: "retired-session" }));
  assert.equal(h.state.activeEncoder, "Compatibility playback");
  await h.apply({ hasVideo: false });
  assert.equal(h.state.activeEncoder, "");
});

test("legacy compatibility negotiation and recovery retain pipeline details", async () => {
  const h = await harness({ quality: false });
  await h.reply({ transcodeInfo: h.info() });
  h.video.dispatch("error", { detail: { message: "connection lost" } });
  assert.match(h.elements.syncStatus.textContent, /Reconnecting playback.*h264_nvenc/);
  await h.reply();
  assert.equal(h.state.activeEncoder, gpu);
  h.video.dispatch("loadeddata"); h.b.runTimers(100); await flush();
  assert.equal(h.elements.syncStatus.textContent, `You control playback • ${gpu}`);
});
