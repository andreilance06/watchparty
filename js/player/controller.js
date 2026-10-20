import "../../vendor/movi-player.js";
import { choosePlayback } from "./playback.js";
import { createMediaEventBridge } from "./media-events.js";
import { createCompatibilityBuffer } from "./compatibility-buffer.js";
import { createSubtitles } from "./subtitles.js";
import { createFullscreen } from "./fullscreen.js";
import { createPlaybackSync } from "./sync.js";

export function createPlayer({ elements, state: session, send, report, files }) {
  const { video, videoPlaceholder, placeholderTitle, placeholderText, viewerControls,
    chooseVideoButton, hostControls, roleBadge, fileName, syncStatus, addCaptionsButton, removeCaptionButton } = elements;
  const subtitles = createSubtitles({ elements, report });
  const sync = createPlaybackSync({ elements, state: session, send });
  const mediaEvents = createMediaEventBridge(video);
  const compatibilityBuffer = createCompatibilityBuffer(video);
  createFullscreen({ elements, getHostPaused: () => session.latestHostPaused, afterResize: subtitles.refreshLayout });
  let latest, sourceKey = "", generation = 0, mode = "", pendingCompatibility = false;
  let switchStarted = 0, lastProgress = 0, lastTime = -1, metrics = {}, selectionStarted = 0;
  const readyState = () => (video.player?.getHLSVideoElement?.() || video.player?.getVideoElement?.() || video).readyState;

  function setVideoSource(url, type, engine) {
    sync.cancel();
    session.sourceSwitching = true;
    session.suppressVideoEvents = true;
    video.pause();
    video.removeAttribute("src");
    video.querySelectorAll("source[data-watchparty-source]").forEach((source) => source.remove());
    if (!url) return;
    session.activeMediaUrl = url;
    mode = engine === "hlsjs native" ? "compatibility" : engine;
    session.playbackMode = mode;
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
    generation++; latest = null; sourceKey = ""; pendingCompatibility = false;
    session.activeMediaUrl = ""; session.latestHostPaused = true;
    setVideoSource(null);
    session.sourceSwitching = false;
    subtitles.setTracks([], { reset: true, key: "" });
    videoPlaceholder.hidden = false; viewerControls.hidden = true;
    fileName.textContent = "No video selected"; syncStatus.textContent = status;
  }

  function requestCompatibility(reason) {
    if (!latest?.hasVideo || pendingCompatibility || mode === "compatibility") return;
    pendingCompatibility = true;
    session.sourceSwitching = true;
    session.suppressVideoEvents = true;
    metrics.fallbackReason = reason; metrics.fallbackStarted = performance.now();
    syncStatus.textContent = "Switching to compatible playback…";
    send({ type: "compatibility-request", mediaVersion: session.mediaVersion, requestId: `playback-${generation}` });
  }
  function applyCompatibility(message) {
    if (!latest || message.mediaVersion !== session.mediaVersion || message.requestId !== `playback-${generation}` || !pendingCompatibility) return;
    pendingCompatibility = false;
    session.playbackRevision = message.playbackRevision ?? session.playbackRevision;
    const authoritative = { ...latest, time: message.time, paused: message.paused, playbackRate: message.playbackRate };
    latest = authoritative;
    session.latestHostPaused = Boolean(message.paused);
    session.activeEncoder = "Compatibility playback";
    metrics.fallbackPending = true;
    setVideoSource(message.url, "application/vnd.apple.mpegurl", "hlsjs native");
  }

  function applySessionState(state) {
    if (!sync.accept(state)) return;
    const compatibilityChanged = latest && mode === "compatibility" &&
      state.compatibilityUrl && state.compatibilityUrl !== latest.compatibilityUrl;
    const key = `${state.mediaVersion ?? ""}:${state.originalUrl || state.mediaUrl || ""}`;
    session.mediaVersion = state.mediaVersion;
    session.latestHostPaused = Boolean(state.paused);
    addCaptionsButton.disabled = !state.hasVideo;
    if (state.processing) {
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
    latest = state;
    fileName.textContent = state.fileName || "Selected video";
    videoPlaceholder.hidden = true; viewerControls.hidden = true;
    if (key !== sourceKey) {
      sourceKey = key; generation++; pendingCompatibility = false; mode = "";
      const token = generation;
      metrics = { selectionStarted: selectionStarted || performance.now() };
      session.sourceSwitching = true; session.activeEncoder = "Direct playback";
      subtitles.setTracks(state.captions, { reset: true, key });
      // Legacy sessions and non-browser tests can still supply HLS alone.
      if (!state.originalUrl) { setVideoSource(state.mediaUrl, "application/vnd.apple.mpegurl", "hlsjs native"); return; }
      choosePlayback(state.mediaInfo).then((choice) => {
        if (token !== generation || !latest) return;
        if (choice === "compatibility") requestCompatibility("device capabilities");
        else setVideoSource(latest.originalUrl, latest.mediaInfo?.mime || "application/octet-stream", choice === "native" ? "native wasm" : "wasm native");
      });
    } else {
      if (state.captions) subtitles.setTracks(state.captions);
      if (compatibilityChanged) setVideoSource(state.compatibilityUrl, "application/vnd.apple.mpegurl", "hlsjs native");
      else if (session.activeMediaUrl && !pendingCompatibility) sync.apply(state, false);
    }
  }

  function applyRole(role) {
    files.setRole(role); session.role = role;
    roleBadge.textContent = role === "host" ? "Host" : "Viewer";
    roleBadge.classList.toggle("host", role === "host");
    hostControls.hidden = role !== "host"; viewerControls.hidden = true; video.controls = true;
    video.removeAttribute("thumb");
    video.toggleAttribute("nohotkeys", role !== "host");
    video.setAttribute("controlslist", role === "host" ? "nocc" : "nocc noseekbuttons noprogress nospeed noloop nopip");
    if (role === "host") {
      video.muted = false;
      if (!Number.isFinite(video.volume) || video.volume < 0.05) video.volume = 1;
      video.setAttribute("fastseek", "buttons keys gestures");
      video.setAttribute("persist", "stablevolume aspect"); video.setAttribute("persistkey", "watchparty-host");
    } else { video.removeAttribute("fastseek"); video.removeAttribute("persist"); }
    syncStatus.textContent = role === "host" ? "Choose a video to begin" : "Waiting for the host";
  }
  function updateEncoder(encoder) {
    if (mode !== "compatibility") return;
    session.activeEncoder = encoder;
    syncStatus.textContent = `${video.paused ? "Ready" : "Playing"} · ${encoder}`;
  }
  function showMediaError(message) {
    placeholderTitle.textContent = "Could not prepare video"; placeholderText.textContent = message;
    videoPlaceholder.hidden = false; syncStatus.textContent = "Choose another video or check the host connection"; report(message);
  }
  function updateCaptions(message) {
    if (message.mediaVersion === session.mediaVersion) subtitles.setTracks(message.captions);
  }
  function ready() {
    if (!latest || !session.activeMediaUrl) return;
    mediaEvents.connect();
    compatibilityBuffer.update();
    sync.update();
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
  // Some native-engine wrappers expose readyState without forwarding every
  // HTML media event. Also observe a first frame while initially paused.
  setInterval(() => {
    if (!latest || !session.activeMediaUrl || pendingCompatibility) return;
    mediaEvents.connect();
    compatibilityBuffer.update();
    sync.update();
    if (session.sourceSwitching && readyState() >= 1) ready();
    if (readyState() >= 2 && (!metrics.firstPictureMs || metrics.fallbackPending)) {
      progress(); video.dispatchEvent(new Event("watchparty-picture-ready"));
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
  addCaptionsButton.addEventListener("click", files.chooseCaptions);
  removeCaptionButton.addEventListener("click", () => files.removeCaption(subtitles.selectedId()));
  video.addEventListener("play", () => sync.broadcast("play"));
  video.addEventListener("pause", () => sync.broadcast("pause"));
  video.addEventListener("watchparty-seek-intent", event => sync.broadcast("seek", event.detail.time));
  video.addEventListener("seeking", () => {
    metrics.seekStarted = performance.now(); lastProgress = performance.now();
    if (!video.player?.getHLSVideoElement?.()) sync.broadcast("seek");
  });
  video.addEventListener("ratechange", () => sync.broadcast("rate"));
  setInterval(() => { if (session.role === "host" && !video.paused) sync.broadcast("tick"); }, 2000);
  setInterval(() => {
    if (!latest || !session.activeMediaUrl || pendingCompatibility || mode === "compatibility" || document.hidden) return;
    const time = Number(video.currentTime) || 0, now = performance.now();
    if (Math.abs(time - lastTime) > 0.05) { lastTime = time; lastProgress = now; }
    const openingStalled = readyState() < 2 && now - switchStarted > 5000;
    const playbackStalled = !latest.paused && !video.paused && !video.ended && now - lastProgress > 5000;
    const seekStalled = metrics.seekStarted && video.seeking && now - metrics.seekStarted > 5000;
    if (openingStalled || playbackStalled || seekStalled) requestCompatibility("playback stalled");
  }, 1000);
  video.addEventListener("smoothwarning", (event) => {
    if (event.detail?.software || event.detail?.playable === false || event.detail?.smooth === false) {
      event.preventDefault(); requestCompatibility("decoder cannot keep up");
    }
  });
  function playbackError(event) {
    if (!latest || session.sourceSwitching && !session.activeMediaUrl) return;
    if (mode !== "compatibility") requestCompatibility("video or audio decoder failed");
    else {
      syncStatus.textContent = "Could not play this video";
      report(event.detail?.message || video.error?.message || "Compatible playback failed. Check the host connection and server encoder.");
    }
  }
  video.addEventListener("error", playbackError);
  video.addEventListener("errordisplay", playbackError);
  video.addEventListener("nativeaudiounsupported", () => {
    if (latest?.mediaInfo?.hasAudio) requestCompatibility("native audio decoder unavailable");
  });
  return { applyRole, applySessionState, applyCompatibility, updateCaptions, updateEncoder, showMediaError, showNoVideo };
}
