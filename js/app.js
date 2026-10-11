import { MoviPlayer } from "../vendor/movi-player.js";

(() => {
  "use strict";

  const canvas = document.querySelector("#videoCanvas");
  const videoShell = document.querySelector("#videoShell");
  const subtitleOverlay = document.querySelector("#subtitleOverlay");
  const videoPlaceholder = document.querySelector("#videoPlaceholder");
  const placeholderTitle = videoPlaceholder.querySelector("strong");
  const placeholderText = videoPlaceholder.querySelector("span:last-child");
  const playerControls = document.querySelector("#playerControls");
  const playPauseButton = document.querySelector("#playPauseButton");
  const progressGroup = document.querySelector("#progressGroup");
  const progressSlider = document.querySelector("#progressSlider");
  const timeDisplay = document.querySelector("#timeDisplay");
  const volumeSlider = document.querySelector("#volumeSlider");
  const captionControl = document.querySelector("#captionControl");
  const captionSelect = document.querySelector("#captionSelect");
  const speedControl = document.querySelector("#speedControl");
  const speedSelect = document.querySelector("#speedSelect");
  const fullscreenButton = document.querySelector("#fullscreenButton");
  const hostControls = document.querySelector("#hostControls");
  const chooseVideoButton = document.querySelector("#chooseVideoButton");
  const roleBadge = document.querySelector("#roleBadge");
  const connectionStatus = document.querySelector("#connectionStatus");
  const statusDot = document.querySelector("#statusDot");
  const fileName = document.querySelector("#fileName");
  const syncStatus = document.querySelector("#syncStatus");
  const viewerCount = document.querySelector("#viewerCount");
  const nameForm = document.querySelector("#nameForm");
  const displayNameInput = document.querySelector("#displayNameInput");
  const chatMessages = document.querySelector("#chatMessages");
  const chatForm = document.querySelector("#chatForm");
  const chatInput = document.querySelector("#chatInput");

  function createClientId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    if (globalThis.crypto?.getRandomValues) {
      const bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
      return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
    }
    return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  let clientId = createClientId();
  const defaultClientName = `Guest-${clientId.slice(0, 4).toUpperCase()}`;
  let clientName = (() => {
    try { return localStorage.getItem("watchparty-display-name")?.trim().slice(0, 24) || defaultClientName; }
    catch { return defaultClientName; }
  })();

  let socket;
  let role = "viewer";
  let player = null;
  let playerGeneration = 0;
  let activeMediaUrl = "";
  let activeEncoder = "";
  let latestHostPaused = true;
  let suppressPlayerActions = false;
  let pendingSessionState = null;
  let draggingProgress = false;
  let currentDuration = 0;
  let currentTime = 0;
  let previousBodyOverflow = "";

  displayNameInput.value = clientName;

  function send(payload) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }

  function setConnection(connected, text) {
    connectionStatus.textContent = text;
    statusDot.classList.toggle("online", connected);
    statusDot.classList.toggle("offline", !connected);
  }

  function addSystemMessage(message) {
    const element = document.createElement("div");
    element.className = "system-message";
    element.textContent = message;
    chatMessages.appendChild(element);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function addChatMessage({ name, message, time, self }) {
    const article = document.createElement("article");
    article.className = `chat-message${self ? " self" : ""}`;
    const meta = document.createElement("div"); meta.className = "meta";
    const who = document.createElement("span"); who.className = "name"; who.textContent = name;
    const when = document.createElement("time"); when.textContent = time;
    const text = document.createElement("p"); text.textContent = message;
    meta.append(who, when); article.append(meta, text); chatMessages.appendChild(article);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function formatTime(value) {
    if (!Number.isFinite(value) || value < 0) return "00:00";
    const seconds = Math.floor(value % 60).toString().padStart(2, "0");
    const minutes = Math.floor(value / 60) % 60;
    const hours = Math.floor(value / 3600);
    return hours ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds}` : `${minutes.toString().padStart(2, "0")}:${seconds}`;
  }

  function updateTimeline(time = currentTime, duration = currentDuration) {
    currentTime = Number.isFinite(time) ? Math.max(0, time) : 0;
    currentDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
    if (!draggingProgress) progressSlider.value = currentDuration ? String(currentTime / currentDuration * 100) : "0";
    timeDisplay.textContent = `${formatTime(currentTime)} / ${formatTime(currentDuration)}`;
  }

  function isPlaying() {
    return player?.getState?.() === "playing";
  }

  function updatePlayButton() {
    const playing = isPlaying();
    playPauseButton.textContent = playing ? "❚❚" : "▶";
    playPauseButton.setAttribute("aria-label", playing ? "Pause" : "Play");
  }

  function updateRoleControls() {
    const host = role === "host";
    hostControls.hidden = !host;
    progressSlider.disabled = !host;
    progressGroup.classList.toggle("viewer-progress", !host);
    speedControl.hidden = !host;
  }

  function resizePlayer() {
    if (!player) return;
    player.resizeCanvas(Math.max(16, videoShell.clientWidth), Math.max(9, videoShell.clientHeight));
  }

  function destroyPlayer() {
    playerGeneration += 1;
    if (player) {
      try { player.destroy(); } catch {}
      player = null;
    }
    subtitleOverlay.replaceChildren();
    captionSelect.replaceChildren(new Option("Off", ""));
    captionControl.hidden = true;
    playerControls.hidden = true;
    currentDuration = 0;
    currentTime = 0;
    updateTimeline();
    updatePlayButton();
  }

  function showNoVideo(status = "Waiting for host") {
    activeMediaUrl = "";
    latestHostPaused = true;
    pendingSessionState = null;
    destroyPlayer();
    videoPlaceholder.hidden = false;
    fileName.textContent = "No video selected";
    syncStatus.textContent = status;
  }

  function normalizedSubtitleTracks(tracks) {
    return (Array.isArray(tracks) ? tracks : []).map((track, index) => ({
      url: track.url,
      lang: track.lang || `und-${index + 1}`,
      label: track.label || `Track ${index + 1}`,
      format: track.format || track.originalFormat || "vtt"
    }));
  }

  async function refreshSubtitleMenu(generation) {
    if (!player || generation !== playerGeneration) return;
    const tracks = player.getSubtitleTracks().filter((track) => track.type === "subtitle");
    captionSelect.replaceChildren(new Option("Off", ""));
    for (const track of tracks) {
      const format = track.codec ? ` (${String(track.codec).toUpperCase()})` : "";
      captionSelect.appendChild(new Option(`${track.label || track.language || "Subtitle"}${format}`, String(track.id)));
    }
    captionControl.hidden = tracks.length === 0;
    if (!tracks.length) return;
    captionSelect.value = String(tracks[0].id);
    const selected = await player.selectSubtitleTrack(tracks[0].id);
    if (!selected && generation === playerGeneration) {
      captionSelect.value = "";
      addSystemMessage(`Movi could not decode ${tracks[0].label || "the first subtitle track"}.`);
    }
  }

  function attachPlayerEvents(instance, generation) {
    instance.on("durationChange", (duration) => {
      if (generation === playerGeneration) updateTimeline(currentTime, Number(duration));
    });
    instance.on("timeUpdate", (time) => {
      if (generation === playerGeneration) updateTimeline(Number(time), instance.getDuration());
    });
    instance.on("stateChange", (state) => {
      if (generation !== playerGeneration) return;
      updatePlayButton();
      if (state === "buffering" || state === "seeking") syncStatus.textContent = state === "buffering" ? "Buffering…" : "Seeking…";
    });
    instance.on("error", (error) => {
      if (generation !== playerGeneration) return;
      syncStatus.textContent = "Could not play this video";
      addSystemMessage(error?.message || "Movi Player could not decode the stream.");
    });
  }

  async function loadPlayer(state) {
    const generation = ++playerGeneration;
    if (player) {
      try { player.destroy(); } catch {}
      player = null;
    }
    subtitleOverlay.replaceChildren();
    captionSelect.replaceChildren(new Option("Off", ""));
    captionControl.hidden = true;
    playerControls.hidden = false;
    syncStatus.textContent = "Loading player…";

    const instance = new MoviPlayer({
      source: { type: "url", url: state.mediaUrl },
      canvas,
      renderer: "canvas",
      forceStreamEngine: "hlsjs",
      enablePreviews: false,
      cache: { type: "lru", maxSizeMB: 128 },
      subtitleTracks: normalizedSubtitleTracks(state.captions)
    });
    player = instance;
    instance.setSubtitleOverlay(subtitleOverlay);
    instance.setSubtitleControlsPadding(72);
    instance.setVolume(Number(volumeSlider.value));
    instance.setMuted(false);
    attachPlayerEvents(instance, generation);

    try {
      await instance.load();
      if (generation !== playerGeneration || player !== instance) return;
      instance.setSubtitleOverlay(subtitleOverlay);
      instance.setSubtitleControlsPadding(72);
      resizePlayer();
      updateTimeline(instance.getCurrentTime(), instance.getDuration());
      await refreshSubtitleMenu(generation);
      if (pendingSessionState) await applyPlaybackState(pendingSessionState, true);
    } catch (error) {
      if (generation !== playerGeneration) return;
      syncStatus.textContent = "Could not load video";
      addSystemMessage(error?.message || "Movi Player failed to load the stream.");
    }
  }

  async function applyPlaybackState(state, sourceChanged = false) {
    if (!player || activeMediaUrl !== state.mediaUrl) return;
    suppressPlayerActions = true;
    const mode = state.syncMode || "tick";
    const playerTime = player.getCurrentTime();
    const difference = Number.isFinite(state.time) ? state.time - playerTime : 0;
    const hardSync = sourceChanged || mode === "source" || mode === "join" || mode === "seek";
    const correctionThreshold = mode === "tick" ? 1 : mode === "pause" ? 0.75 : 1.5;
    const hostRate = Number.isFinite(state.playbackRate) ? state.playbackRate : 1;
    let targetRate = hostRate;
    if (role === "viewer" && mode === "tick" && !state.paused && Math.abs(difference) >= 0.12 && Math.abs(difference) <= 1) targetRate = hostRate + Math.max(-0.05, Math.min(0.05, difference * 0.1));
    player.setPlaybackRate(targetRate);
    if (role === "host") speedSelect.value = String(hostRate);
    if (Number.isFinite(state.time) && Math.abs(difference) > (hardSync ? 0.25 : correctionThreshold)) await player.seek(state.time).catch(() => {});

    if (state.paused) {
      player.pause();
      syncStatus.textContent = role === "host" ? `You control playback${activeEncoder ? ` • ${activeEncoder}` : ""}` : "Paused";
    } else if (!isPlaying()) {
      await player.play().then(() => { syncStatus.textContent = role === "host" ? "You control playback" : "Synchronized with host"; })
        .catch(() => { syncStatus.textContent = "Tap play once if your browser blocks playback"; });
    } else syncStatus.textContent = role === "host" ? "You control playback" : "Synchronized with host";
    updatePlayButton();
    setTimeout(() => { suppressPlayerActions = false; }, hardSync ? 400 : 100);
  }

  function applySessionState(state) {
    pendingSessionState = state;
    latestHostPaused = Boolean(state.paused);
    if (state.encoder) activeEncoder = state.encoder;
    if (state.processing) {
      activeMediaUrl = "";
      destroyPlayer();
      videoPlaceholder.hidden = false;
      placeholderTitle.textContent = "Preparing stream…";
      placeholderText.textContent = "Building the full seekable timeline and extracting subtitle tracks.";
      fileName.textContent = state.fileName || "Selected video";
      syncStatus.textContent = "Extracting subtitles and preparing timeline";
      return;
    }
    if (!state.hasVideo) {
      placeholderTitle.textContent = "Waiting for the host";
      placeholderText.textContent = "The host will choose a video file and start the watch party.";
      showNoVideo(role === "host" ? "Choose a video to begin" : "Waiting for the host");
      return;
    }
    fileName.textContent = state.fileName || "Selected video";
    videoPlaceholder.hidden = true;
    playerControls.hidden = false;
    const sourceChanged = activeMediaUrl !== state.mediaUrl;
    if (sourceChanged) {
      activeMediaUrl = state.mediaUrl;
      loadPlayer(state);
    } else applyPlaybackState(state, false);
  }

  function handleMessage(message) {
    switch (message.type) {
      case "role":
        clientId = message.clientId;
        if (message.name) {
          clientName = message.name;
          displayNameInput.value = clientName;
          try { localStorage.setItem("watchparty-display-name", clientName); } catch {}
        }
        if (message.nameRejected) addSystemMessage(`“${message.nameRejected}” is already in use. You joined as ${clientName}.`);
        role = message.role;
        roleBadge.textContent = role === "host" ? "Host" : "Viewer";
        roleBadge.classList.toggle("host", role === "host");
        updateRoleControls();
        viewerCount.textContent = `${message.viewerCount} online`;
        syncStatus.textContent = role === "host" ? "Choose a video to begin" : "Waiting for the host";
        break;
      case "presence": viewerCount.textContent = `${message.count} online`; break;
      case "session-state": applySessionState(message); break;
      case "transcode-info": activeEncoder = message.encoder; syncStatus.textContent = `${isPlaying() ? "Playing" : "Ready"} • ${message.encoder}`; break;
      case "media-error":
        placeholderTitle.textContent = "Could not prepare video";
        placeholderText.textContent = message.message;
        videoPlaceholder.hidden = false;
        syncStatus.textContent = "Choose another video or check FFmpeg";
        addSystemMessage(message.message);
        break;
      case "chat": addChatMessage({ ...message, self: message.clientId === clientId }); break;
      case "name-updated":
        clientName = message.name; displayNameInput.value = clientName; displayNameInput.removeAttribute("aria-invalid");
        try { localStorage.setItem("watchparty-display-name", clientName); } catch {}
        addSystemMessage(`Your display name is now ${clientName}.`);
        break;
      case "name-rejected":
        clientName = message.name; displayNameInput.value = clientName; displayNameInput.setAttribute("aria-invalid", "true");
        try { localStorage.setItem("watchparty-display-name", clientName); } catch {}
        addSystemMessage(message.message || "That display name is already in use.");
        break;
      case "host-left": showNoVideo("Host disconnected"); addSystemMessage("The host left. Waiting for a new host..."); break;
      case "error": addSystemMessage(message.message); break;
    }
  }

  function connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${location.host}`);
    socket.addEventListener("open", () => { setConnection(true, "Connected"); send({ type: "join", clientId, name: clientName }); });
    socket.addEventListener("message", (event) => handleMessage(JSON.parse(event.data)));
    socket.addEventListener("close", () => { setConnection(false, "Disconnected"); setTimeout(connect, 1500); });
    socket.addEventListener("error", () => setConnection(false, "Connection error"));
  }

  function broadcastVideoState(syncMode = "tick") {
    const viewerPlayPause = role === "viewer" && (syncMode === "play" || syncMode === "pause");
    if ((role !== "host" && !viewerPlayPause) || suppressPlayerActions || !activeMediaUrl || !player) return;
    send({ type: "video-state", paused: !isPlaying(), time: player.getCurrentTime(), playbackRate: player.getPlaybackRate(), syncMode });
  }

  playPauseButton.addEventListener("click", async () => {
    if (!player) return;
    try {
      player.setMuted(false);
      if (isPlaying()) { player.pause(); updatePlayButton(); broadcastVideoState("pause"); }
      else { await player.play(); updatePlayButton(); broadcastVideoState("play"); }
    } catch { syncStatus.textContent = "Your browser blocked playback; tap again"; }
  });

  progressSlider.addEventListener("pointerdown", () => { draggingProgress = true; });
  progressSlider.addEventListener("input", () => {
    if (currentDuration) timeDisplay.textContent = `${formatTime(Number(progressSlider.value) / 100 * currentDuration)} / ${formatTime(currentDuration)}`;
  });
  progressSlider.addEventListener("change", async () => {
    draggingProgress = false;
    if (role !== "host" || !player || !currentDuration) return;
    await player.seek(Number(progressSlider.value) / 100 * currentDuration).catch(() => {});
    broadcastVideoState("seek");
  });

  volumeSlider.addEventListener("input", () => {
    if (!player) return;
    const volume = Number(volumeSlider.value);
    player.setVolume(volume); player.setMuted(volume <= 0);
  });

  speedSelect.addEventListener("change", () => {
    if (role !== "host" || !player) return;
    player.setPlaybackRate(Number(speedSelect.value)); broadcastVideoState("rate");
  });

  captionSelect.addEventListener("change", async () => {
    if (!player) return;
    const id = captionSelect.value;
    const selected = await player.selectSubtitleTrack(id || null);
    if (!selected && id) { captionSelect.value = ""; addSystemMessage("Movi Player could not decode that subtitle track."); }
  });

  chooseVideoButton.addEventListener("click", async () => {
    chooseVideoButton.disabled = true; chooseVideoButton.textContent = "Opening file picker...";
    try {
      const response = await fetch("/api/select-video", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId }) });
      const result = await response.json();
      if (!response.ok || result.error) throw new Error(result.error || "Could not choose a video.");
    } catch (error) { addSystemMessage(error.message); }
    finally { chooseVideoButton.disabled = false; chooseVideoButton.innerHTML = '<span aria-hidden="true">＋</span> Choose Video'; }
  });

  function fullscreenElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function updateFullscreenUi() {
    const active = Boolean(fullscreenElement()) || videoShell.classList.contains("pseudo-fullscreen");
    fullscreenButton.setAttribute("aria-label", active ? "Exit fullscreen" : "Enter fullscreen");
    fullscreenButton.title = active ? "Exit fullscreen" : "Fullscreen";
    requestAnimationFrame(resizePlayer);
  }
  async function toggleFullscreenSurface() {
    if (fullscreenElement()) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      return;
    }
    if (videoShell.classList.contains("pseudo-fullscreen")) {
      videoShell.classList.remove("pseudo-fullscreen"); document.body.style.overflow = previousBodyOverflow; updateFullscreenUi(); return;
    }
    if (videoShell.requestFullscreen) { await videoShell.requestFullscreen(); return; }
    if (videoShell.webkitRequestFullscreen) { videoShell.webkitRequestFullscreen(); return; }
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    videoShell.classList.add("pseudo-fullscreen"); updateFullscreenUi();
  }

  fullscreenButton.addEventListener("click", async () => {
    try {
      player?.setMuted(false);
      const playAttempt = player && !latestHostPaused && !isPlaying() ? player.play().catch(() => {}) : Promise.resolve();
      await toggleFullscreenSurface(); await playAttempt;
    } catch { syncStatus.textContent = "Fullscreen is not available in this browser"; }
  });
  document.addEventListener("fullscreenchange", updateFullscreenUi);
  document.addEventListener("webkitfullscreenchange", updateFullscreenUi);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && videoShell.classList.contains("pseudo-fullscreen")) {
      videoShell.classList.remove("pseudo-fullscreen"); document.body.style.overflow = previousBodyOverflow; updateFullscreenUi();
    }
  });

  const resizeObserver = globalThis.ResizeObserver ? new ResizeObserver(resizePlayer) : null;
  resizeObserver?.observe(videoShell);
  if (!resizeObserver) window.addEventListener("resize", resizePlayer);
  window.addEventListener("orientationchange", resizePlayer);
  setInterval(() => { if (role === "host" && isPlaying()) broadcastVideoState("tick"); }, 2000);

  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const message = chatInput.value.trim();
    if (!message) return;
    send({ type: "chat", message }); chatInput.value = ""; chatInput.focus();
  });
  nameForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const nextName = displayNameInput.value.replace(/\s+/g, " ").trim().slice(0, 24);
    if (!nextName) { displayNameInput.value = clientName; return; }
    clientName = nextName; displayNameInput.value = clientName;
    try { localStorage.setItem("watchparty-display-name", clientName); } catch {}
    send({ type: "set-name", name: clientName }); chatInput.focus();
  });
  displayNameInput.addEventListener("input", () => displayNameInput.removeAttribute("aria-invalid"));

  updateRoleControls();
  connect();
})();
