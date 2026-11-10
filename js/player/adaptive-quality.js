import { createLifecycle } from "../utils/lifecycle.js";
import { chooseAutomaticQuality, createQualityHysteresis } from "./quality-policy.js";
import { createNativeQualityMenu } from "./native-quality-menu.js";

export function createAdaptiveQuality({ video, session, send, switchSource, switchRendition, fail, report, surface, validateOriginal, onRenditionReady, playbackStatus }) {
  const life = createLifecycle();
  let source, engine, current, pending, serial = 0, throughput = 0, measuredAt = 0, demand = {}, blockedUntil = 0;
  let preferences = { quality: "auto", bitrate: "auto" }, warning = "", retryUsed = false, loading, loader;
  let deferred, awaitingSeek = false, refreshKey;
  const replacements = new Map();
  const hysteresis = createQualityHysteresis();
  const menu = createNativeQualityMenu({ video, onChange: change });
  const enabled = () => Boolean(source?.mediaInfo?.qualityOptions?.length);
  const sourceSupported = () => engine && engine !== "compatibility";
  const options = () => source?.mediaInfo?.qualityOptions || [];
  const bitrateRange = () => source?.mediaInfo?.bitrateRange || { min: 25000,
    max: Math.max(750000, ...(source?.mediaInfo?.bitrateLimits || []), ...options().map(option => option.bitrate)), step: 1000 };
  const sourceProfile = () => {
    const width = Math.max(2, Math.floor((source.mediaInfo.width || 1920) / 2) * 2);
    const height = Math.max(2, Math.floor((source.mediaInfo.height || 1080) / 2) * 2);
    return { quality: "source", width, height, bitrate: "source", rateControl: "near-lossless",
      estimatedBitrate: bitrateRange().max * 2, id: `${width}x${height}_source`, reason: "Source (compatible near-lossless transcode)" };
  };
  const now = () => performance.now();
  let assessing = false, assessmentStarted = false, assessmentTimer, adjusting = false;
  function clearAssessment() { clearTimeout(assessmentTimer); assessmentTimer = undefined; assessing = false; }
  function clearStatus() { clearAssessment(); adjusting = false; playbackStatus?.clear("quality"); }
  function progressStatus() {
    if (adjusting) playbackStatus?.set("quality", { text: "Adjusting quality...", pending: true });
    else if (assessing) playbackStatus?.set("quality", { text: "Checking connection speed...", pending: true });
  }
  function startAssessment() {
    if (assessmentStarted || !enabled() || preferences.quality !== "auto") return;
    assessmentStarted = true; assessing = true; progressStatus();
    assessmentTimer = setTimeout(() => {
      clearAssessment();
      if (!adjusting) playbackStatus?.set("quality", { text: "Connection estimate unavailable; continuing with Auto" });
    }, 10000);
  }
  function statusFailure(message) {
    clearAssessment(); adjusting = false;
    playbackStatus?.set("quality", { text: message });
  }
  function statusReady() {
    if (!adjusting) return;
    adjusting = false; clearAssessment();
    playbackStatus?.set("quality", { text: current?.id === "source" ? "Using original quality" : `Using ${current.height}p quality` });
  }
  function paint(reason) {
    const actual = current?.id === "source" ? `Original (${source?.mediaInfo?.height || "?"}p)` :
      current?.rateControl === "near-lossless" ? `Source (${current.width}×${current.height}, compatible near-lossless transcode)` :
      current ? `${current.width}×${current.height}, ${current.bitrate / 1000000} Mbps limit` : "Preparing playback";
    video.watchpartyQualityMetrics = { preferences: { ...preferences }, rendition: current, throughputBps: throughput,
      provider: demand.provider, server: { active: demand.active, limit: demand.limit, pressure: demand.pressure, encodingRatio: demand.encodingRatio },
      reason: reason || current?.reason || "", pending: pending?.target?.id || null, warning };
    menu.update({ enabled: enabled(), mediaVersion: source?.mediaVersion, ...(pending?.settings || preferences), options: options(),
      bitrateRange: bitrateRange(), label: `${preferences.quality === "auto" ? "Auto · " : ""}${actual}`,
      status: `${actual}. ${pending ? "Preparing selected quality…" : warning || reason || current?.reason || ""}` });
  }
  function cancelPending() {
    if (!pending) return;
    clearTimeout(pending.timer); pending.controller?.abort(); pending = null;
  }
  function clearLoading() { clearTimeout(loading?.timer); loading = null; }
  function suspend() {
    deferred = pending ? { target: pending.target, settings: pending.settings } : deferred;
    cancelPending(); clearLoading(); refreshKey = undefined;
  }
  function seekStarted() {
    if (!enabled()) return;
    awaitingSeek = true;
    suspend();
  }
  function refresh(snapshot = source) {
    source = { ...source, playbackRevision: snapshot.playbackRevision, streamGeneration: snapshot.streamGeneration };
    awaitingSeek = false;
    const profile = pending?.target || deferred?.target || current;
    const settings = pending?.settings || deferred?.settings || preferences;
    if (!profile || profile.id === "source") return;
    const replacement = replacements.get(profile.id);
    const revision = session.playbackRevision ?? 0, generation = source.streamGeneration ?? 0;
    // Replacement notifications precede seek acknowledgements. Wait until the
    // sync layer accepts the latest command before preparing its fragments.
    if (replacement && (replacement.playbackRevision > revision || replacement.streamGeneration > generation)) return;
    const key = `${profile.id}:${revision}:${generation}:${replacement?.renditionGeneration ?? ""}`;
    if (refreshKey === key) return;
    clearLoading(); deferred = undefined;
    request(profile, settings, "Following the shared playhead", true);
    refreshKey = key;
  }
  function beginLoading(apply, announce = true) {
    clearLoading();
    const attempt = loading = { retiredPlayer: video.player, announce };
    apply();
    attempt.timer = setTimeout(() => {
      if (loading !== attempt) return;
      clearLoading();
      const message = "The selected quality could not start playback. Check the connection and try Auto.";
      if (attempt.announce && preferences.quality === "auto" || assessing || adjusting) statusFailure(message);
      fail(message);
    }, 10000);
  }
  function settleLoading() {
    if (loading && (!loading.retiredPlayer || video.player !== loading.retiredPlayer) && surface().readyState >= 2 && !session.sourceSwitching) { clearLoading(); statusReady(); }
  }
  function profileFor(settings) {
    if (settings.quality === "source") return sourceSupported() && now() >= blockedUntil ?
      { id: "source", reason: "Selected in Settings" } : sourceProfile();
    if (settings.quality !== "auto") {
      const option = options().find(option => option.quality === settings.quality);
      if (!option) return null;
      const bitrate = settings.bitrate === "auto" ? option.bitrate : settings.bitrate;
      return { ...option, bitrate, id: `${option.width}x${option.height}_${bitrate}`, reason: "Selected in Settings" };
    }
    const hint = globalThis.navigator?.connection?.downlink;
    const bps = throughput || (hint > 0 ? hint * 1000000 : 0);
    const provider = demand.provider && Date.now() - demand.provider.sampledAt < 15000 ? demand.provider.bps : 0;
    return chooseAutomaticQuality({ options: options(), bitrate: settings.bitrate, bps,
      sourceBitrate: source.mediaInfo.bitrate || 0, sourceSupported: sourceSupported() && now() >= blockedUntil,
      providerBps: provider, pressure: demand.pressure, encodingRatio: demand.encodingRatio, current });
  }
  function changed(profile, settings, reason) {
    current = { ...profile, reason }; preferences = { ...settings }; warning = "";
    hysteresis.reset(now());
    send({ type: "quality-selection", mediaVersion: source.mediaVersion, renditionId: profile.id });
    paint(reason);
  }
  function request(profile, settings = preferences, reason = profile?.reason, recover = false, announce = true) {
    if (!profile || !enabled()) return;
    refreshKey = undefined;
    deferred = undefined;
    cancelPending();
    if (current?.id === profile.id && !recover) {
      preferences = { ...settings };
      if (adjusting) { adjusting = false; playbackStatus?.clear("quality"); progressStatus(); }
      paint(reason); return;
    }
    if (settings.quality === "auto" && current && current.id !== profile.id && !recover && announce) {
      adjusting = true; progressStatus();
    }
    if (profile.id === "source") {
      if (source.mediaInfo?.hdr && validateOriginal) {
        const attempt = pending = { target: profile, settings: { ...settings }, announce };
        paint(reason);
        Promise.resolve().then(validateOriginal).then(choice => {
          if (pending !== attempt) return;
          pending = null;
          engine = choice;
          if (choice !== "native") {
            const compatible = settings.quality === "source" ? settings : { quality: "auto", bitrate: settings.bitrate };
            request(profileFor(compatible), compatible, "HDR playback is unavailable on this display", false, announce);
            return;
          }
          beginLoading(() => switchSource(choice), announce); changed(profile, settings, reason);
        }).catch(() => {
          if (pending !== attempt) return;
          pending = null; engine = "compatibility";
          const compatible = settings.quality === "source" ? settings : { quality: "auto", bitrate: settings.bitrate };
          request(profileFor(compatible), compatible, "Original playback is unavailable", false, announce);
        });
        return;
      }
      if (!sourceSupported()) { request(sourceProfile(), settings, undefined, false, announce); return; }
      beginLoading(() => switchSource(engine), announce); changed(profile, settings, reason); return;
    }
    const requestId = `quality-${source.mediaVersion}-${++serial}`;
    const attempt = pending = { requestId, target: profile, settings: { ...settings }, reason, recover, announce,
      controller: typeof AbortController === "function" ? new AbortController() : null };
    attempt.timer = setTimeout(() => rejected("The selected quality could not be prepared. Try Auto or check the connection.", attempt), 10000);
    if (send({ type: "compatibility-request", mediaVersion: source.mediaVersion, requestId,
      quality: profile.quality, bitrate: profile.bitrate, automatic: settings.quality === "auto" }) === false) {
      rejected("Connection lost while selecting quality.", attempt);
    }
    paint(reason);
  }
  function rejected(message, attempt = pending) {
    if (!attempt || pending !== attempt) return;
    if (attempt.announce && attempt.settings.quality === "auto" || assessing || adjusting) statusFailure(message);
    cancelPending(); warning = message;
    // Until the first successful selection there is no previous playback to keep.
    if (!current) fail(message); else if (attempt.recover) fail(message); else report(message);
    paint();
  }
  function change(settings) {
    if (!enabled()) return;
    clearStatus();
    if (loading) loading.announce = false;
    if (settings.quality === "source") {
      settings = { quality: "source", bitrate: "source" };
      if (source.mediaInfo?.hdr && validateOriginal) {
        request({ id: "source", reason: "Selected in Settings" }, settings, undefined, false, false); return;
      }
    }
    const profile = profileFor(settings);
    request(profile, settings, undefined, false, false);
  }
  async function ready(message) {
    const attempt = pending;
    if (!attempt || message.requestId !== attempt.requestId || message.mediaVersion !== source?.mediaVersion) return false;
    if ((message.playbackRevision ?? 0) < (session.playbackRevision ?? 0)) {
      request(attempt.target, attempt.settings, attempt.reason, true, attempt.announce); return true;
    }
    if (attempt.preparing) return true;
    attempt.preparing = true;
    onRenditionReady?.(message);
    try {
      // This is the selected rendition's first real demand. Prepare just the
      // current fragment before replacing a working player; HLS reuses its cache.
      const index = Math.max(0, Math.min(Math.ceil(source.duration / message.segmentSeconds) - 1,
        Math.floor(message.time / message.segmentSeconds)));
      if (index > 0) {
        const bootstrap = await fetch(message.url.replace("master.m3u8", "segment_000000.ts"), { signal: attempt.controller?.signal });
        if (!bootstrap.ok) throw new Error("The selected quality could not initialize. Keep the current quality or try Auto.");
        await bootstrap.arrayBuffer();
        if (pending !== attempt) return true;
      }
      const segment = message.url.replace("master.m3u8", `segment_${String(index).padStart(6, "0")}.ts`);
      const response = await fetch(segment, { signal: attempt.controller?.signal });
      if (!response.ok) throw new Error("The selected quality is unavailable. Keep the current quality or try Auto.");
      await response.arrayBuffer();
      if (pending !== attempt || message.mediaVersion !== source?.mediaVersion) return true;
      if ((message.playbackRevision ?? 0) < (session.playbackRevision ?? 0)) {
        request(attempt.target, attempt.settings, attempt.reason, true, attempt.announce); return true;
      }
      clearTimeout(attempt.timer); pending = null;
      beginLoading(() => switchRendition(message, attempt.recover), attempt.announce);
      changed(message.rendition, attempt.settings, attempt.reason);
    } catch (error) { if (pending === attempt) rejected(error.message, attempt); }
    return true;
  }
  function sample(bps) {
    if (!Number.isFinite(bps) || bps <= 0 || bps > 1e12) return;
    throughput = throughput ? throughput * 0.65 + bps * 0.35 : bps; measuredAt = now();
    if (assessing) {
      clearAssessment();
      if (!adjusting) playbackStatus?.set("quality", { text: "Connection speed checked" });
    }
  }
  function fragmentLoaded(event, data) {
    const stats = data?.frag?.stats || data?.stats;
    const duration = stats?.loading?.end - stats?.loading?.first;
    if (stats?.total >= 32768 && duration > 0) sample(stats.total * 8000 / Math.max(1, duration));
  }
  function connectLoader() {
    const next = video.player?.streamWrapper?.hls;
    if (next === loader) return;
    loader?.off?.("hlsFragLoaded", fragmentLoaded); loader = next;
    loader?.on?.("hlsFragLoaded", fragmentLoaded);
  }
  if (typeof PerformanceObserver === "function") {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (!source || !entry.name?.includes(`v=${source.mediaVersion}`) || entry.transferSize === 0 || !entry.encodedBodySize) continue;
        const relevant = entry.name.includes("/media/original?") && current?.id === "source" ||
          [current?.id, pending?.target?.id].filter(Boolean).some(id => entry.name.includes(`r=${id}&`));
        const duration = entry.responseEnd - entry.responseStart;
        // Headers are sent after encoding, so deliberate server waits and TTFB
        // do not masquerade as a slow viewer connection.
        if (relevant && duration > 0 && entry.encodedBodySize >= 32768) sample(entry.encodedBodySize * 8000 / Math.max(1, duration));
      }
    });
    observer.observe({ type: "resource", buffered: false });
  }
  function tick() {
    if (!enabled()) return;
    connectLoader(); settleLoading();
    const active = surface();
    let buffer = 0;
    for (let index = 0; index < (active.buffered?.length || 0); index++) {
      if (active.buffered.start(index) <= active.currentTime && active.buffered.end(index) >= active.currentTime)
        buffer = active.buffered.end(index) - active.currentTime;
    }
    send({ type: "quality-telemetry", mediaVersion: source.mediaVersion,
      throughputBps: throughput, bufferedSeconds: buffer, renditionId: current?.id });
    if (document.hidden || awaitingSeek || deferred || active.paused || active.seeking || session.sourceSwitching || loading || pending || !current) { hysteresis.reset(now()); return; }
    if (measuredAt && now() - measuredAt > 20000) { throughput = 0; measuredAt = 0; }
    const provider = demand.provider;
    const starved = provider?.samples >= 3 && Date.now() - provider.sampledAt < 15000 && provider.bps < (source.mediaInfo.bitrate || 0);
    if (starved) warning = "The video provider’s connection may be too slow to supply the original file.";
    if (preferences.quality !== "auto") {
      if (buffer < 1 && active.readyState < 3) warning = "This setting is buffering. Choose Auto to adapt to this connection.";
      paint(); return;
    }
    let candidate = profileFor(preferences);
    // When downloads have not completed yet, actual buffer exhaustion is still
    // useful evidence. Do not keep spawning smaller encodes for provider starvation.
    if (!starved && buffer < 1 && active.readyState < 3 && current.id !== "source") {
      const lower = options().find(option => option.height < current.height);
      const limit = lower && (preferences.bitrate === "auto" ? lower.bitrate : Math.min(lower.bitrate, preferences.bitrate));
      if (lower) candidate = { ...lower, bitrate: limit, id: `${lower.width}x${lower.height}_${limit}`, reason: "Reducing buffering" };
    }
    if (!starved && hysteresis.evaluate({ now: now(), current, candidate, urgent: buffer < 0.5 && active.readyState < 3 })) request(candidate);
    else paint();
  }
  life.interval(tick, 2000);
  life.listen(document, "visibilitychange", () => { throughput = 0; measuredAt = 0; hysteresis.reset(now()); });
  function reset(snapshot) {
    clearStatus(); assessmentStarted = false;
    if (source) send({ type: "quality-release", mediaVersion: source.mediaVersion });
    cancelPending(); clearLoading(); loader?.off?.("hlsFragLoaded", fragmentLoaded); loader = null;
    deferred = undefined; awaitingSeek = false; refreshKey = undefined; replacements.clear();
    source = snapshot; current = null; engine = null; throughput = 0; measuredAt = 0; demand = {};
    blockedUntil = 0; warning = ""; retryUsed = false; hysteresis.reset(now());
    if (enabled() && preferences.quality !== "auto" && preferences.quality !== "source" && !options().some(option => option.quality === preferences.quality)) preferences.quality = "auto";
    if (enabled() && typeof preferences.bitrate === "number") {
      preferences.bitrate = Math.max(bitrateRange().min, Math.min(bitrateRange().max, preferences.bitrate));
    }
    paint();
  }
  function start(choice) {
    engine = choice;
    startAssessment();
    request(profileFor(preferences));
  }
  function fallback(reason, recover = false) {
    if (!enabled()) return false;
    if (pending) return true;
    if (recover) {
      if (retryUsed) { fail("Playback could not reconnect. Check the provider connection."); return true; }
      retryUsed = true; request(current, preferences, "Reconnecting playback", true); return true;
    }
    if (/decoder|capabil/.test(reason)) engine = "compatibility";
    blockedUntil = now() + 60000;
    request(profileFor(preferences), preferences, reason); return true;
  }
  function handle(message) {
    if (message.type === "compatibility-ready" && message.requestId?.startsWith("quality-")) { ready(message); return true; }
    if (!enabled() || message.mediaVersion !== source.mediaVersion) return false;
    if (message.type === "quality-error") {
      if (pending?.requestId === message.requestId) rejected(message.message);
      return true;
    }
    if (message.type === "quality-status") { demand = message; paint(); return true; }
    if (["rendition-replaced", "rendition-error"].includes(message.type)) {
      if (message.renditionId === current?.id || message.renditionId === pending?.target?.id || message.renditionId === deferred?.target?.id) {
        const previous = replacements.get(message.renditionId);
        if ((message.playbackRevision ?? Infinity) < (session.playbackRevision ?? 0) || previous &&
            ((message.streamGeneration ?? Infinity) < previous.streamGeneration ||
             message.streamGeneration === previous.streamGeneration && message.renditionGeneration < previous.renditionGeneration)) return true;
        if (message.type === "rendition-replaced") {
          if (previous?.url === message.url) return true;
          replacements.set(message.renditionId, message);
          const wait = awaitingSeek || message.playbackRevision > (session.playbackRevision ?? 0) ||
            message.streamGeneration > (source.streamGeneration ?? 0);
          suspend();
          if (!wait) refresh();
        }
        else fallback(message.message, true);
      }
      return true;
    }
    return false;
  }
  function updatePlayback(choice) {
    engine = choice;
    if (choice === "compatibility" && source?.mediaInfo?.hdr) {
      cancelPending();
      request(profileFor(preferences), preferences, "HDR playback is unavailable on this display");
    } else paint();
  }
  return { destroy() { life.dispose(); reset(null); menu.destroy(); }, enabled, reset, start, fallback, handle, settleLoading, updatePlayback, seekStarted, refresh,
    failed(message) { if (assessing || adjusting) statusFailure(message); },
    needsRefresh: () => awaitingSeek || Boolean(deferred),
    waiting: () => Boolean(loading?.retiredPlayer && loading.retiredPlayer === video.player),
    managed: () => enabled() && Boolean(current || pending || deferred),
    renditionId: () => current?.id };
}
