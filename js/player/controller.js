import "../../vendor/movi-player.js";
import { createSubtitles } from "./subtitles.js";
import { createFullscreen } from "./fullscreen.js";
import { createPlaybackSync } from "./sync.js";

export function createPlayer({ elements, state: session, send, report, files }) {
  const {
    video, videoPlaceholder, placeholderTitle, placeholderText, viewerControls,
    chooseVideoButton, hostControls, roleBadge, fileName, syncStatus, addCaptionsButton, removeCaptionButton
  } = elements;
  const subtitles = createSubtitles({ elements, report });
  const sync = createPlaybackSync({ elements, state: session, send });
  createFullscreen({
    elements, getHostPaused: () => session.latestHostPaused, afterResize: subtitles.refreshLayout
  });

  function showNoVideo(status = "Waiting for host") {
    session.activeMediaUrl = "";
    session.latestHostPaused = true;
    video.pause(); video.removeAttribute("src");
    video.querySelectorAll("source[data-watchparty-source]").forEach((source) => source.remove());
    subtitles.setTracks([]);
    videoPlaceholder.hidden = false; viewerControls.hidden = true;
    fileName.textContent = "No video selected"; syncStatus.textContent = status;
  }

  function setVideoSource(url) {
    video.removeAttribute("src");
    video.querySelectorAll("source[data-watchparty-source]").forEach((source) => source.remove());
    if (!url) return;
    const source = document.createElement("source");
    source.src = url;
    source.type = "application/vnd.apple.mpegurl";
    source.dataset.watchpartySource = "";
    video.appendChild(source);
  }

  function applySessionState(state) {
    session.mediaVersion = state.mediaVersion;
    addCaptionsButton.disabled = !state.hasVideo;
    session.latestHostPaused = Boolean(state.paused);
    if (state.encoder) session.activeEncoder = state.encoder;
    if (state.processing) {
      session.activeMediaUrl = "";
      video.pause(); setVideoSource(null); subtitles.setTracks([]);
      videoPlaceholder.hidden = false; viewerControls.hidden = true;
      placeholderTitle.textContent = "Preparing stream…";
      placeholderText.textContent = "Building the full seekable timeline and detecting captions.";
      fileName.textContent = state.fileName || "Selected video";
      syncStatus.textContent = "Extracting captions and preparing timeline";
      return;
    }
    if (!state.hasVideo) {
      placeholderTitle.textContent = "Waiting for the host";
      placeholderText.textContent = "The host will choose a video file and start the watch party.";
      showNoVideo(session.role === "host" ? "Choose a video to begin" : "Waiting for the host");
      return;
    }
    fileName.textContent = state.fileName || "Selected video";
    videoPlaceholder.hidden = true;
    viewerControls.hidden = true;
    const sourceChanged = session.activeMediaUrl !== state.mediaUrl;
    if (sourceChanged) {
      session.activeMediaUrl = state.mediaUrl;
      subtitles.setTracks(state.captions, { reset: true });
      setVideoSource(state.mediaUrl);
    } else if (state.captions) {
      subtitles.setTracks(state.captions);
    }
    sync.apply(state, sourceChanged);
  }

  function applyRole(role) {
    files.setRole(role);
    session.role = role;
    roleBadge.textContent = role === "host" ? "Host" : "Viewer";
    roleBadge.classList.toggle("host", role === "host");
    hostControls.hidden = role !== "host";
    viewerControls.hidden = true;
    video.controls = true;
    // Sampling thumbnails across the file competes with playback range requests.
    video.removeAttribute("thumb");
    video.toggleAttribute("nohotkeys", role !== "host");
    if (role === "host") {
      video.removeAttribute("controlslist");
      video.muted = false;
      if (!Number.isFinite(video.volume) || video.volume < 0.05) video.volume = 1;
      video.setAttribute("fastseek", "buttons keys gestures");
      video.setAttribute("persist", "speed subtitles stablevolume aspect");
      video.setAttribute("persistkey", "watchparty-host");
    } else {
      video.setAttribute("controlslist", "noseekbuttons noprogress nospeed noloop nopip");
      video.removeAttribute("fastseek");
      video.removeAttribute("persist");
    }
    syncStatus.textContent = role === "host" ? "Choose a video to begin" : "Waiting for the host";
  }

  function updateEncoder(encoder) {
    session.activeEncoder = encoder;
    syncStatus.textContent = `${video.paused ? "Ready" : "Playing"} • ${encoder}`;
  }

  function showMediaError(message) {
    placeholderTitle.textContent = "Could not prepare video";
    placeholderText.textContent = message;
    videoPlaceholder.hidden = false;
    syncStatus.textContent = "Choose another video or check FFmpeg";
    report(message);
  }

  chooseVideoButton.addEventListener("click", files.chooseVideo);
  addCaptionsButton.addEventListener("click", files.chooseCaptions);
  removeCaptionButton.addEventListener("click", () => files.removeCaption(subtitles.selectedId()));

  function updateCaptions(message) {
    if (message.mediaVersion === session.mediaVersion) subtitles.setTracks(message.captions);
  }

  video.addEventListener("pointerdown", () => {
    if (session.role !== "viewer") return;
    // A click on any local Movi control is also a browser-approved media
    // gesture. Use it to recover sound/autoplay on Firefox Mobile.
    video.muted = false;
    if (!Number.isFinite(video.volume) || video.volume < 0.05) video.volume = 1;
    if (!session.latestHostPaused && video.paused) video.play().catch(() => {});
  });

  video.addEventListener("play", () => sync.broadcast("play"));
  video.addEventListener("pause", () => sync.broadcast("pause"));
  video.addEventListener("seeking", () => sync.broadcast("seek"));
  video.addEventListener("ratechange", () => sync.broadcast("rate"));
  setInterval(() => { if (session.role === "host" && !video.paused) sync.broadcast("tick"); }, 2000);
  video.addEventListener("error", (event) => {
    syncStatus.textContent = "Could not play this video";
    report(event.detail?.message || video.error?.message || "The player could not decode this video format.");
  });

  return { applyRole, applySessionState, updateCaptions, updateEncoder, showMediaError, showNoVideo };
}
