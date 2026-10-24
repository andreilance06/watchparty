const fs = require("node:fs");
const path = require("node:path");
const { createSegmentService } = require("./segments");
const { writePlaylists, segmentSchedule, streamDirectory } = require("./playlists");
const { currentTime } = require("../state");
const { resolveQuality } = require("./quality");

function createRenditionService({ state, config, encoderPromise, broadcast }) {
  const entries = new Map(), viewers = new Map(), generations = new Map();
  let timer;
  const url = entry => `${state.basePath || ""}/hls/master.m3u8?v=${state.mediaVersion}&g=${state.streamGeneration || 0}&r=${entry.profile.id}&rg=${entry.state.streamGeneration}`;
  const sendReplacement = entry => {
    generations.set(entry.profile.id, entry.state.streamGeneration);
    broadcast({ type: "rendition-replaced", mediaVersion: state.mediaVersion, renditionId: entry.profile.id, url: url(entry) });
  };
  function references(id, now = Date.now()) {
    const entry = entries.get(id);
    return entry?.requests > 0 || [...viewers.values()].some(viewer => now - viewer.lastSeen < 15000 && viewer.current === id ||
      now - viewer.pendingAt < 10000 && viewer.pending === id);
  }
  function bytes(directory) {
    try {
      return fs.readdirSync(directory, { withFileTypes: true }).reduce((sum, file) => {
        const target = path.join(directory, file.name);
        return sum + (file.isDirectory() ? bytes(target) : fs.statSync(target).size);
      }, 0);
    } catch (error) {
      // A retired generation can be removed while inactive files are counted.
      if (error.code === "ENOENT") return 0;
      throw error;
    }
  }
  function collect() {
    const now = Date.now();
    for (const [id, viewer] of viewers) if (now - viewer.lastSeen > 30000 && now - viewer.pendingAt > 10000) viewers.delete(id);
    for (const entry of entries.values()) {
      if (references(entry.profile.id, now)) { entry.idleAt = null; continue; }
      entry.idleAt ??= now;
      if (!entry.retired && now - entry.idleAt >= (config.renditionIdleMs ?? 10000)) {
        entry.retired = true;
        const last = segmentSchedule(entry.state, config.segmentSeconds).count - 1;
        const complete = fs.existsSync(path.join(streamDirectory(entry.state), `segment_${String(last).padStart(6, "0")}.ts`));
        entry.needsRestart = entry.service.running() || !complete;
        entry.drained = entry.service.cancel();
      }
    }
    const inactive = [...entries.values()].filter(entry => entry.retired).sort((a, b) => a.usedAt - b.usedAt);
    let total = inactive.reduce((sum, entry) => sum + (entry.cachedBytes = bytes(entry.state.hlsDirectory)), 0);
    for (const entry of inactive) {
      if (total <= (config.renditionCacheBytes ?? 128 * 1024 * 1024)) break;
      entries.delete(entry.profile.id); total -= entry.cachedBytes;
      generations.set(entry.profile.id, entry.state.streamGeneration);
      // Direct children are constructed exclusively from validated profile IDs.
      const directory = entry.state.hlsDirectory;
      if (path.dirname(directory) === state.hlsDirectory && /^r_\d+x\d+_\d+_\d+$/.test(path.basename(directory))) {
        Promise.resolve(entry.drained).then(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }, () => {}));
      }
    }
  }
  function create(profile) {
    const local = Object.create(state);
    const initialGeneration = (generations.get(profile.id) ?? -1) + 1;
    generations.set(profile.id, initialGeneration);
    Object.assign(local, { roomState: state, rendition: profile, streamGeneration: initialGeneration,
      compatibilityStartIndex: Math.max(0, Math.floor(currentTime(state) / segmentSchedule(state, config.segmentSeconds).seconds) - 1),
      hlsDirectory: path.join(state.hlsDirectory, `r_${profile.id}_${initialGeneration}`), selectedEncoder: "Compatibility playback" });
    const entry = { profile, state: local, usedAt: Date.now(), retired: false, idleAt: null };
    entry.service = createSegmentService({ state: local, config, encoderPromise, broadcast(message) {
      if (message.type === "session-state") sendReplacement(entry);
      else if (message.type === "media-error") broadcast({ ...message, type: "rendition-error", mediaVersion: state.mediaVersion, renditionId: profile.id });
      else broadcast({ ...message, renditionId: profile.id });
    } });
    fs.mkdirSync(local.hlsDirectory, { recursive: true });
    writePlaylists(local, config.segmentSeconds);
    entries.set(profile.id, entry);
    if (!timer) { timer = setInterval(collect, 1000); timer.unref?.(); }
    return entry;
  }
  function select(clientId, quality, bitrate, automatic = false) {
    let profile = resolveQuality(state.mediaInfo, quality, bitrate);
    const load = config.encoderBudget?.snapshot();
    if (load?.active >= load.limit && !entries.has(profile.id)) {
      const shared = automatic && [...entries.values()].filter(entry => entry.service.running() &&
        entry.profile.height <= profile.height && entry.profile.bitrate <= profile.bitrate)
        .sort((a, b) => b.profile.height - a.profile.height || b.profile.bitrate - a.profile.bitrate)[0];
      if (shared) profile = shared.profile;
      else throw Object.assign(new Error("The server is busy. Keep the current quality or try Auto again shortly."), { code: "QUALITY_BUSY" });
    }
    const entry = entries.get(profile.id) || create(profile);
    if (entry.retired && entry.needsRestart) { entry.service.restart(); generations.set(profile.id, entry.state.streamGeneration); }
    entry.retired = false; entry.idleAt = null; entry.usedAt = Date.now();
    const viewer = viewers.get(clientId) || {};
    Object.assign(viewer, { pending: profile.id, pendingAt: Date.now(), lastSeen: Date.now() });
    viewers.set(clientId, viewer);
    return { rendition: profile, url: url(entry), renditionGeneration: entry.state.streamGeneration };
  }
  function commit(clientId, id) {
    const viewer = viewers.get(clientId);
    if (id === "source") { viewers.delete(clientId); return; }
    if (!viewer || !entries.has(id) || ![viewer.pending, viewer.current].includes(id)) throw new Error("Select this rendition before playing it.");
    viewer.current = id; viewer.pending = null; viewer.lastSeen = Date.now();
  }
  function touch(clientId) { const viewer = viewers.get(clientId); if (viewer) viewer.lastSeen = Date.now(); }
  function restart() { for (const entry of entries.values()) { entry.service.restart(); sendReplacement(entry); } }
  function stop() {
    clearInterval(timer); timer = null;
    for (const entry of entries.values()) entry.service.cancel();
    entries.clear(); viewers.clear(); generations.clear();
  }
  function get(id) { return entries.get(id); }
  function demand() {
    return { ...config.encoderBudget?.snapshot(), provider: state.sourcePerformance || null,
      renditions: [...entries.values()].filter(entry => !entry.retired && references(entry.profile.id)).map(entry => entry.profile) };
  }
  return { select, commit, touch, restart, stop, get, demand, collect, release: clientId => viewers.delete(clientId) };
}

module.exports = { createRenditionService };
