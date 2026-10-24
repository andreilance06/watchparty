import { chooseAutomaticQuality, createQualityHysteresis } from "./quality-policy.js";
import { createNativeQualityMenu } from "./native-quality-menu.js";

export function createAdaptiveQuality({ video, session, send, switchSource, switchRendition, fail, report, surface }) {
  let source, engine, current, pending, serial = 0, throughput = 0, measuredAt = 0, demand = {}, blockedUntil = 0;
  let preferences = { quality: "auto", bitrate: "auto" }, warning = "", retryUsed = false, loading, loader;
  const hysteresis = createQualityHysteresis();
  const menu = createNativeQualityMenu({ video, onChange: change });
  const enabled = () => Boolean(source?.mediaInfo?.qualityOptions?.length);
  const sourceSupported = () => engine && engine !== "compatibility";
  const options = () => source?.mediaInfo?.qualityOptions || [];
  const now = () => performance.now();
  function paint(reason) {
    const actual = current?.id === "source" ? `Original (${source?.mediaInfo?.height || "?"}p)` :
      current ? `${current.width}×${current.height}, ${current.bitrate / 1000000} Mbps limit` : "Preparing playback";
    video.watchpartyQualityMetrics = { preferences: { ...preferences }, rendition: current, throughputBps: throughput,
      provider: demand.provider, server: { active: demand.active, limit: demand.limit, pressure: demand.pressure, encodingRatio: demand.encodingRatio },
      reason: reason || current?.reason || "", pending: pending?.target?.id || null, warning };
    menu.update({ enabled: enabled(), ...(pending?.settings || preferences), sourceSupported: Boolean(sourceSupported()), options: options(),
      bitrateLimits: source?.mediaInfo?.bitrateLimits || [], label: `${preferences.quality === "auto" ? "Auto · " : ""}${actual}`,
      status: `${actual}. ${pending ? "Preparing selected quality…" : warning || reason || current?.reason || ""}` });
  }
  function cancelPending() {
    if (!pending) return;
    clearTimeout(pending.timer); pending.controller?.abort(); pending = null;
  }
  function clearLoading() { clearTimeout(loading?.timer); loading = null; }
  function beginLoading(apply) {
    clearLoading();
    const attempt = loading = { retiredPlayer: video.player };
    apply();
    attempt.timer = setTimeout(() => {
      if (loading !== attempt) return;
      clearLoading(); fail("The selected quality could not start playback. Check the connection and try Auto.");
    }, 10000);
  }
  function settleLoading() {
    if (loading && (!loading.retiredPlayer || video.player !== loading.retiredPlayer) && surface().readyState >= 2 && !session.sourceSwitching) clearLoading();
  }
  function profileFor(settings) {
    if (settings.quality === "source") return { id: "source", reason: "Selected in Settings" };
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
  function request(profile, settings = preferences, reason = profile?.reason, recover = false) {
    if (!profile || !enabled()) return;
    if (profile.id === "source" && !sourceSupported()) { warning = "Original playback is unsupported on this device. Choose Auto."; paint(); return; }
    cancelPending();
    if (current?.id === profile.id && !recover) { preferences = { ...settings }; paint(reason); return; }
    if (profile.id === "source") {
      beginLoading(() => switchSource(engine)); changed(profile, settings, reason); return;
    }
    const requestId = `quality-${source.mediaVersion}-${++serial}`;
    const attempt = pending = { requestId, target: profile, settings: { ...settings }, reason, recover,
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
    cancelPending(); warning = message;
    // Until the first successful selection there is no previous playback to keep.
    if (!current) fail(message); else if (attempt.recover) fail(message); else report(message);
    paint();
  }
  function change(settings) {
    if (!enabled()) return;
    const profile = profileFor(settings);
    request(profile, settings);
  }
  async function ready(message) {
    const attempt = pending;
    if (!attempt || message.requestId !== attempt.requestId || message.mediaVersion !== source?.mediaVersion) return false;
    if ((message.playbackRevision ?? 0) < (session.playbackRevision ?? 0)) {
      request(attempt.target, attempt.settings, attempt.reason, true); return true;
    }
    try {
      // This is the selected rendition's first real demand. Prepare just the
      // current fragment before replacing a working player; HLS reuses its cache.
      const index = Math.floor(message.time / message.segmentSeconds);
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
        request(attempt.target, attempt.settings, attempt.reason, true); return true;
      }
      clearTimeout(attempt.timer); pending = null;
      beginLoading(() => switchRendition(message, attempt.recover));
      changed(message.rendition, attempt.settings, attempt.reason);
    } catch (error) { if (pending === attempt) rejected(error.message, attempt); }
    return true;
  }
  function sample(bps) {
    if (!Number.isFinite(bps) || bps <= 0 || bps > 1e12) return;
    throughput = throughput ? throughput * 0.65 + bps * 0.35 : bps; measuredAt = now();
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
    if (document.hidden || active.paused || active.seeking || session.sourceSwitching || loading || pending || !current) { hysteresis.reset(now()); return; }
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
  setInterval(tick, 2000);
  document.addEventListener("visibilitychange", () => { throughput = 0; measuredAt = 0; hysteresis.reset(now()); });
  function reset(snapshot) {
    if (source) send({ type: "quality-release", mediaVersion: source.mediaVersion });
    cancelPending(); clearLoading(); loader?.off?.("hlsFragLoaded", fragmentLoaded); loader = null;
    source = snapshot; current = null; engine = null; throughput = 0; measuredAt = 0; demand = {};
    blockedUntil = 0; warning = ""; retryUsed = false; hysteresis.reset(now());
    if (enabled() && preferences.quality !== "auto" && preferences.quality !== "source" && !options().some(option => option.quality === preferences.quality)) preferences.quality = "auto";
    paint();
  }
  function start(choice) {
    engine = choice;
    if (preferences.quality === "source" && !sourceSupported()) preferences = { quality: "auto", bitrate: "auto" };
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
    if (preferences.quality === "source") { warning = `${reason}. Choose Auto for compatible playback.`; paint(); fail(warning); return true; }
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
      if (message.renditionId === current?.id) {
        if (message.type === "rendition-replaced") request(current, preferences, "Following the shared playhead", true);
        else fallback(message.message, true);
      }
      return true;
    }
    return false;
  }
  return { enabled, reset, start, fallback, handle, settleLoading,
    waiting: () => Boolean(loading?.retiredPlayer && loading.retiredPlayer === video.player),
    managed: () => enabled() && Boolean(current || pending),
    refresh: () => {
      const profile = pending?.target || current;
      if (profile && profile.id !== "source") request(profile, pending?.settings || preferences, "Following the shared playhead", true);
    },
    renditionId: () => current?.id };
}
