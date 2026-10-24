import "../../vendor/movi-player.js";
import { choosePlayback } from "./playback.js";
import { createMediaEventBridge } from "./media-events.js";
import { createCompatibilityBuffer } from "./compatibility-buffer.js";
import { createAdaptiveQuality } from "./adaptive-quality.js";
import { createSubtitles } from "./subtitles.js";
import { createFullscreen } from "./fullscreen.js";
import { createPlaybackSync } from "./sync.js";
import { canControl, DEFAULT_PERMISSIONS } from "../permissions.js";

export function createPlayer({ elements, state: session, send, report, files, attention }) {
  const { video, videoPlaceholder, placeholderTitle, placeholderText, viewerControls,
    chooseVideoButton, hostControls, roleBadge, fileName, syncStatus } = elements;
  const subtitles = createSubtitles({ elements, report, onAddCaptions: files.chooseCaptions });
  const sync = createPlaybackSync({ elements, state: session, send });
  const mediaEvents = createMediaEventBridge(video);
  const compatibilityBuffer = createCompatibilityBuffer(video);
  createFullscreen({ elements, getHostPaused: () => session.latestHostPaused, afterResize: subtitles.refreshLayout, attention });
  let latest, latestAt = 0, sourceKey = "", generation = 0, mode = "", pendingCompatibility;
  let switchStarted = 0, lastProgress = 0, lastTime = -1, metrics = {}, selectionStarted = 0;
  let requestSequence = 0, requestTimer, recoveryTimer, recovery, recoveryUsed = false, terminalError = false;
  let watchingPlayback = false;
  const surface = () => video.player?.getHLSVideoElement?.() || video.player?.getVideoElement?.() || video;
  const readyState = () => surface().readyState;
  const quality = createAdaptiveQuality({ video, session, send, report, surface, fail: failPlayback,
    switchSource(engine) {
      terminalError = false; cancelRecovery(); advanceSnapshot();
      setVideoSource(latest.originalUrl, latest.mediaInfo?.mime || "application/octet-stream", engine === "native" ? "native wasm" : "wasm native");
    },
    switchRendition(message, recover) {
      terminalError = false; cancelRecovery(); advanceSnapshot();
      session.activeEncoder = "Compatibility playback";
      if (recover && session.activeMediaUrl === message.url && typeof video.load === "function") {
        setVideoSource(message.url, "application/vnd.apple.mpegurl", "hlsjs native");
        Promise.resolve().then(() => video.load()).catch(error => failPlayback(error.message));
      } else setVideoSource(message.url, "application/vnd.apple.mpegurl", "hlsjs native");
    }
  });
  function advanceSnapshot() {
    if (!latest) return;
    latest = { ...latest, time: Math.min(latest.duration || Infinity,
      latest.time + (latest.paused ? 0 : (performance.now() - latestAt) / 1000 * (latest.playbackRate || 1))) };
    latestAt = performance.now();
  }

  function resetProgress() {
    lastProgress = performance.now(); lastTime = Number(surface().currentTime) || 0;
    watchingPlayback = false;
  }

  function clearCompatibilityRequest() {
    clearTimeout(requestTimer); requestTimer = undefined; pendingCompatibility = undefined;
  }

  function cancelRecovery() {
    clearCompatibilityRequest();
    clearTimeout(recoveryTimer); recoveryTimer = undefined; recovery = undefined;
  }

  function failPlayback(message) {
    if (terminalError) return;
    terminalError = true;
    cancelRecovery(); sync.cancel();
    session.suppressVideoEvents = true;
    session.sourceSwitching = false;
    video.pause();
    syncStatus.textContent = "Could not play this video";
    report(message);
  }

  // Source changes are asynchronous in Movi. Never use the retired player's
  // readyState or errors to complete/fail its replacement.
  const awaitingReplacement = () => Boolean(recovery?.phase === "loading" && recovery.player && recovery.player === video.player) || quality.waiting();

  function reloadCompatibility(url) {
    const sameSource = session.activeMediaUrl === url;
    const attempt = recovery;
    if (recovery) {
      recovery.phase = "loading";
      recovery.player = video.player;
      clearTimeout(recoveryTimer);
      recoveryTimer = setTimeout(() => failPlayback("Playback could not reconnect. Check the host connection and try again."), 10000);
    }
    setVideoSource(url, "application/vnd.apple.mpegurl", "hlsjs native");
    if (recovery) syncStatus.textContent = "Reconnecting playback…";
    // Movi ignores identical <source> signatures. An idle connection failure
    // usually keeps the same URL, so explicitly rebuild through its public API.
    if (attempt && sameSource && typeof video.load === "function") {
      Promise.resolve().then(() => {
        if (recovery === attempt) return video.load();
      }).catch(error => {
        if (recovery === attempt) failPlayback(error.message || "Playback could not reconnect.");
      });
    }
  }

  function setVideoSource(url, type, engine) {
    subtitles.sourceChanging();
    sync.cancel();
    session.sourceSwitching = true;
    session.suppressVideoEvents = true;
    video.pause();
    video.removeAttribute("src");
    video.querySelectorAll("source[data-watchparty-source]").forEach((source) => source.remove());
    if (!url) return;
    session.activeMediaUrl = url;
    mode = engine === "hlsjs native" ? "compatibility" : engine.split(" ")[0];
    session.playbackMode = mode;
    metrics.playbackMode = mode;
    video.watchpartyMetrics = metrics;
    video.setAttribute("engine", engine);
    video.setAttribute("startat", String(latest?.time || 0));
    const source = document.createElement("source");
    source.src = url; source.type = type; source.dataset.watchpartySource = "";
    video.appendChild(source);
    switchStarted = performance.now(); lastProgress = switchStarted; lastTime = -1;
    syncStatus.textContent = mode === "compatibility" ? "Preparing compatible playback…" : "Opening video…";
    // Real players load asynchronously. Already-ready DOM doubles also exercise
    // the synchronous sync path without waiting for a browser metadata event.
    if (!video.player && video.readyState >= 1) sync.apply(latest, true);
  }

  function showNoVideo(status = "Waiting for host") {
    quality.reset(null);
    cancelRecovery(); terminalError = false; recoveryUsed = false;
    generation++; latest = null; sourceKey = "";
    session.activeMediaUrl = ""; session.latestHostPaused = true;
    setVideoSource(null);
    session.sourceSwitching = false;
    subtitles.setTracks([], { reset: true, key: "" });
    subtitles.setAvailability({ hasVideo: false, canAdd: false });
    videoPlaceholder.hidden = false; viewerControls.hidden = true;
    fileName.textContent = "No video selected"; syncStatus.textContent = status;
  }

  function sendCompatibilityRequest() {
    pendingCompatibility = { requestId: `playback-${generation}-${++requestSequence}` };
    if (send({ type: "compatibility-request", mediaVersion: session.mediaVersion, requestId: pendingCompatibility.requestId }) === false) {
      failPlayback("Playback could not reconnect. Check your connection and try again.");
    }
  }

  function requestCompatibility(reason, recover = false) {
    if (!latest?.hasVideo || terminalError || pendingCompatibility || (mode === "compatibility" && !recover)) return;
    if (quality.enabled()) {
      metrics.fallbackReason = reason; metrics.fallbackStarted = performance.now(); metrics.fallbackPending = true;
      if (quality.fallback(reason, recover)) return;
    }
    if (recover) {
      if (recoveryUsed) { failPlayback(reason); return; }
      recoveryUsed = true;
      recovery = { phase: "request", started: performance.now(), player: video.player };
      metrics.recoveryAttempts = 1;
    } else {
      metrics.fallbackReason = reason; metrics.fallbackStarted = performance.now();
    }
    session.sourceSwitching = true;
    session.suppressVideoEvents = true;
    sync.cancel();
    video.watchpartyMetrics = metrics;
    syncStatus.textContent = recover ? "Reconnecting playback…" : "Switching to compatible playback…";
    requestTimer = setTimeout(() => failPlayback("Playback could not reconnect. Check the host connection and try again."), 10000);
    sendCompatibilityRequest();
  }
  function applyCompatibility(message) {
    if (quality.handle(message)) return;
    if (!latest || terminalError || !pendingCompatibility || message.mediaVersion !== session.mediaVersion || message.requestId !== pendingCompatibility.requestId) return;
    if ((message.playbackRevision ?? 0) < (session.playbackRevision ?? 0)) {
      // A seek/host transfer can overtake the reply. Keep the original deadline
      // while requesting the current revision with a new correlation ID.
      sendCompatibilityRequest(); return;
    }
    clearCompatibilityRequest();
    session.playbackRevision = message.playbackRevision ?? session.playbackRevision;
    const authoritative = { ...latest, playbackRevision: session.playbackRevision, compatibilityUrl: message.url,
      streamGeneration: message.streamGeneration ?? latest.streamGeneration,
      time: message.time, paused: message.paused, playbackRate: message.playbackRate };
    latest = authoritative;
    latestAt = performance.now();
    session.latestHostPaused = Boolean(message.paused);
    session.activeEncoder = "Compatibility playback";
    if (!recovery) metrics.fallbackPending = true;
    reloadCompatibility(message.url);
  }

  function applySessionState(state) {
    if (!sync.accept(state)) return;
    files.setSession?.(state);
    session.sourceOwnerId = state.sourceOwnerId;
    updateSharingStatus();
    const compatibilityChanged = latest && mode === "compatibility" &&
      state.compatibilityUrl && state.compatibilityUrl !== latest.compatibilityUrl;
    const key = `${state.mediaVersion ?? ""}:${state.originalUrl || state.mediaUrl || ""}`;
    session.mediaVersion = state.mediaVersion;
    session.latestHostPaused = Boolean(state.paused);
    subtitles.setAvailability({ hasVideo: Boolean(state.hasVideo && !state.processing), canAdd: session.role === "host" });
    if (state.processing) {
      quality.reset(null);
      cancelRecovery(); terminalError = false; recoveryUsed = false;
      generation++; latest = null; sourceKey = "";
      selectionStarted = performance.now();
      session.activeMediaUrl = "";
      setVideoSource(null); subtitles.setTracks([], { reset: true, key });
      videoPlaceholder.hidden = false; viewerControls.hidden = true;
      placeholderTitle.textContent = "Opening video…";
      placeholderText.textContent = "Reading video information. Captions load separately.";
      fileName.textContent = state.fileName || "Selected video";
      syncStatus.textContent = "Reading video information";
      return;
    }
    if (!state.hasVideo) {
      placeholderTitle.textContent = "Waiting for the host";
      placeholderText.textContent = "The host will choose a video file and start the watch party.";
      showNoVideo(session.role === "host" ? "Choose a video to begin" : "Waiting for the host"); return;
    }
    latest = state; latestAt = performance.now();
    fileName.textContent = state.fileName || "Selected video";
    videoPlaceholder.hidden = true; viewerControls.hidden = true;
    if (key !== sourceKey) {
      cancelRecovery(); terminalError = false; recoveryUsed = false;
      sourceKey = key; generation++; mode = "";
      quality.reset(state);
      const token = generation;
      metrics = { selectionStarted: selectionStarted || performance.now() };
      session.sourceSwitching = true; session.activeEncoder = "Direct playback";
      subtitles.setTracks(state.captions, { reset: true, key });
      // Legacy sessions and non-browser tests can still supply HLS alone.
      if (!state.originalUrl) { setVideoSource(state.mediaUrl, "application/vnd.apple.mpegurl", "hlsjs native"); return; }
      choosePlayback(state.mediaInfo).then((choice) => {
        if (token !== generation || !latest || terminalError) return;
        if (quality.enabled()) quality.start(choice);
        else if (choice === "compatibility") requestCompatibility("device capabilities");
        else setVideoSource(latest.originalUrl, latest.mediaInfo?.mime || "application/octet-stream", choice === "native" ? "native wasm" : "wasm native");
      });
    } else {
      if (state.captions) subtitles.setTracks(state.captions);
      if (terminalError) return;
      if (compatibilityChanged) {
        clearCompatibilityRequest();
        if (quality.managed()) quality.refresh(); else reloadCompatibility(state.compatibilityUrl);
      } else if (session.activeMediaUrl && !pendingCompatibility && !awaitingReplacement()) sync.apply(state, false);
      if (recovery) syncStatus.textContent = "Reconnecting playback…";
    }
  }

  function applyRole(role) {
    files.setRole(role); session.role = role;
    subtitles.setAvailability({ canAdd: role === "host" });
    updateSharingStatus();
    roleBadge.textContent = role === "host" ? "Host" : "Viewer";
    roleBadge.classList.toggle("host", role === "host");
    hostControls.hidden = role !== "host"; viewerControls.hidden = true; video.controls = true;
    video.removeAttribute("thumb");
    updateControls();
    if (role === "host") {
      video.muted = false;
      if (!Number.isFinite(video.volume) || video.volume < 0.05) video.volume = 1;
      video.setAttribute("fastseek", "buttons keys gestures");
      video.setAttribute("persist", "stablevolume aspect"); video.setAttribute("persistkey", "watchparty-host");
    } else { video.removeAttribute("persist"); }
    syncStatus.textContent = latest?.hasVideo ? (role === "host" ? "You control playback" : "Synchronized with host") : role === "host" ? "Choose a video to begin" : "Waiting for the host";
  }

  function updateSharingStatus() {
    elements.fileSharingStatus.hidden = session.role === "host" || !session.sourceOwnerId || session.sourceOwnerId !== session.clientId;
  }

  function updateControls() {
    const host = session.role === "host";
    const flags = [];
    if (!host) flags.push("noloop", "nopip", "noplaylist");
    if (!canControl(session, "play")) flags.push("noplay", "nocenterplay");
    if (!canControl(session, "seek")) flags.push("noseekbuttons", "noprogress", "notimeline", "nochapters");
    if (!canControl(session, "rate")) flags.push("nospeed");
    video.setAttribute("controlslist", flags.join(" "));
    video.toggleAttribute("nohotkeys", !host);
    if (canControl(session, "seek")) video.setAttribute("fastseek", host ? "buttons keys gestures" : "buttons gestures");
    else video.setAttribute("fastseek", "false");
  }

  function applyPermissions(value) {
    session.permissions = { ...(value || DEFAULT_PERMISSIONS) };
    updateControls();
  }

  function rejectPlayback(message) {
    if (sync.reject(message)) applySessionState(message.state);
  }

  function localIntent(mode, target) {
    if (session.suppressVideoEvents || session.sourceSwitching) return;
    if (mode === "rate" && sync.isAppliedRate()) return;
    if (!canControl(session, mode)) {
      if (latest && session.activeMediaUrl) {
        const elapsed = latest.paused ? 0 : (performance.now() - latestAt) / 1000 * (latest.playbackRate || 1);
        sync.apply({ ...latest, time: Math.min(latest.duration || Infinity, latest.time + elapsed), syncMode: "correction" }, false);
      }
      return;
    }
    sync.broadcast(mode, target);
  }

  // Movi's built-in keyboard handler does not gate all transport shortcuts.
  // Viewers use this small permission-aware handler while hosts keep Movi's.
  video.addEventListener("keydown", event => {
    if (session.role === "host" || event.ctrlKey || event.metaKey || event.altKey || !session.activeMediaUrl) return;
    if ((event.composedPath?.() || []).some(node => /^(INPUT|TEXTAREA|SELECT|BUTTON)$/i.test(node.tagName) || node.isContentEditable)) return;
    const key = event.key.toLowerCase();
    if ([" ", "k"].includes(key) && canControl(session, "play")) {
      event.preventDefault();
      if (video.paused) video.play().catch(() => {}); else video.pause();
    } else if (["arrowleft", "arrowright"].includes(key) && canControl(session, "seek")) {
      event.preventDefault();
      video.currentTime = Math.max(0, Math.min(latest?.duration || Infinity, video.currentTime + (key === "arrowleft" ? -10 : 10)));
    } else if (["<", ">"].includes(key) && canControl(session, "rate")) {
      event.preventDefault(); video.playbackRate = Math.min(4, Math.max(.25, video.playbackRate + (key === "<" ? -.25 : .25)));
    }
  });
  function updateEncoder(encoder, renditionId) {
    if (quality.enabled() && renditionId !== quality.renditionId()) return;
    if (mode !== "compatibility") return;
    session.activeEncoder = encoder;
    syncStatus.textContent = `${video.paused ? "Ready" : "Playing"} · ${encoder}`;
  }
  function showMediaError(message) {
    terminalError = true; cancelRecovery(); sync.cancel();
    session.suppressVideoEvents = true; session.sourceSwitching = false;
    video.pause();
    placeholderTitle.textContent = "Could not prepare video"; placeholderText.textContent = message;
    videoPlaceholder.hidden = false; syncStatus.textContent = "Choose another video or check the host connection"; report(message);
  }
  function updateCaptions(message) {
    if (message.mediaVersion === session.mediaVersion) subtitles.setTracks(message.captions);
  }
  function ready() {
    if (!latest || !session.activeMediaUrl || terminalError || pendingCompatibility || awaitingReplacement()) return;
    mediaEvents.connect();
    compatibilityBuffer.update();
    sync.update();
    quality.settleLoading();
    // canplay also fires after ordinary seeks. Reapplying the last server
    // snapshot there would undo a host seek whose broadcast excludes its sender.
    if (!session.sourceSwitching || sync.isApplying()) return;
    sync.apply(latest, true);
    lastProgress = performance.now();
  }
  function progress() {
    lastProgress = performance.now();
    if (readyState() >= 2 && !metrics.firstPictureMs) {
      metrics.firstPictureMs = performance.now() - metrics.selectionStarted;
      video.watchpartyMetrics = metrics;
    }
    if (readyState() >= 2 && metrics.fallbackPending) {
      metrics.fallbackMs = performance.now() - metrics.fallbackStarted;
      metrics.fallbackPending = false; video.watchpartyMetrics = metrics;
    }
  }
  video.addEventListener("loadedmetadata", ready);
  video.addEventListener("canplay", ready);
  video.addEventListener("loadeddata", progress);
  video.addEventListener("playing", progress);
  document.addEventListener("visibilitychange", resetProgress);
  // Some native-engine wrappers expose readyState without forwarding every
  // HTML media event. Also observe a first frame while initially paused.
  setInterval(() => {
    if (!latest || !session.activeMediaUrl || terminalError || pendingCompatibility || awaitingReplacement()) return;
    mediaEvents.connect();
    compatibilityBuffer.update();
    sync.update();
    if (session.sourceSwitching && readyState() >= 1) ready();
    if (readyState() >= 2 && (!metrics.firstPictureMs || metrics.fallbackPending)) {
      progress(); video.dispatchEvent(new Event("watchparty-picture-ready"));
    }
    if (recovery) {
      if (readyState() >= 2 && !session.sourceSwitching) {
        metrics.recoveryMs = performance.now() - recovery.started;
        clearTimeout(recoveryTimer); recoveryTimer = undefined; recovery = undefined;
        syncStatus.textContent = session.role === "host"
          ? `You control playback${session.activeEncoder ? ` • ${session.activeEncoder}` : ""}`
          : session.latestHostPaused ? "Paused" : "Synchronized with host";
      } else syncStatus.textContent = "Reconnecting playback…";
    }
  }, 100);
  video.addEventListener("seeked", () => {
    if (metrics.seekStarted) { metrics.seekMs = performance.now() - metrics.seekStarted; metrics.seekStarted = 0; video.watchpartyMetrics = metrics; }
    progress();
  });
  video.addEventListener("pointerdown", () => {
    if (session.role !== "viewer" || session.sourceSwitching) return;
    video.muted = false;
    if (!Number.isFinite(video.volume) || video.volume < 0.05) video.volume = 1;
    if (!session.latestHostPaused && video.paused) video.play().catch(() => {});
  });
  chooseVideoButton.addEventListener("click", files.chooseVideo);
  video.addEventListener("play", () => { resetProgress(); localIntent("play"); });
  video.addEventListener("pause", () => { resetProgress(); localIntent("pause"); });
  video.addEventListener("watchparty-seek-intent", event => {
    if (!session.suppressVideoEvents && !session.sourceSwitching && !canControl(session, "seek")) event.preventDefault();
    localIntent("seek", event.detail.time);
  });
  video.addEventListener("seeking", () => {
    metrics.seekStarted = performance.now(); lastProgress = performance.now();
    if (!video.player?.getHLSVideoElement?.()) localIntent("seek");
  });
  video.addEventListener("ratechange", () => localIntent("rate"));
  setInterval(() => { if (session.role === "host" && !video.paused) sync.broadcast("tick"); }, 2000);
  setInterval(() => {
    if (!latest || !session.activeMediaUrl || terminalError || pendingCompatibility || mode === "compatibility") return;
    const active = surface(), time = Number(active.currentTime) || 0, now = performance.now();
    const playing = !document.hidden && !active.paused && !video.ended && !session.sourceSwitching;
    if (!playing || !watchingPlayback) { lastProgress = now; lastTime = time; }
    watchingPlayback = playing;
    if (document.hidden) return;
    if (Math.abs(time - lastTime) > 0.05) { lastTime = time; lastProgress = now; }
    const openingStalled = session.sourceSwitching && readyState() < 2 && now - switchStarted > 5000;
    const playbackStalled = playing && now - lastProgress >= 5000;
    const seekStalled = metrics.seekStarted && video.seeking && now - metrics.seekStarted > 5000;
    if (openingStalled || playbackStalled || seekStalled) requestCompatibility("playback stalled");
  }, 1000);
  video.addEventListener("smoothwarning", (event) => {
    if (event.detail?.measured || event.detail?.software || event.detail?.playable === false || event.detail?.smooth === false) {
      event.preventDefault(); requestCompatibility("decoder cannot keep up");
    }
  });
  function playbackError(event) {
    if (!latest || terminalError || pendingCompatibility || awaitingReplacement() || session.sourceSwitching && !session.activeMediaUrl) return;
    if (mode !== "compatibility") requestCompatibility("video or audio decoder failed");
    else {
      const message = event.detail?.message || video.error?.message || "Compatible playback failed. Check the host connection and server encoder.";
      if (recovery) failPlayback(message);
      else requestCompatibility(message, true);
    }
  }
  video.addEventListener("error", playbackError);
  video.addEventListener("errordisplay", playbackError);
  video.addEventListener("nativeaudiounsupported", () => {
    if (latest?.mediaInfo?.hasAudio) requestCompatibility("native audio decoder unavailable");
  });
  return { applyRole, applyPermissions, rejectPlayback, applySessionState, applyCompatibility, updateCaptions, updateEncoder, showMediaError, showNoVideo,
    handleQuality: quality.handle, disconnect: () => quality.reset(null) };
}
