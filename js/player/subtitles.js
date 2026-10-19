import JASSUB from "../../vendor/jassub/jassub.js";

export function createSubtitles({ elements, report }) {
  const { video, videoShell, videoPlaceholder, captionControl, captionSelect, syncStatus } = elements;
  let subtitleCanvas = null;
  let captionTracks = [];
  let captionSignature = "";
  let subtitleRenderer = null;
  let subtitleGeneration = 0;
  let lastSubtitleFrame = "";
  let lastSubtitleRenderAt = 0;
  let subtitleLayoutSignature = "";
  let subtitleResizeFrame = 0;
  let subtitleResizeTimer = 0;

  function replaceSubtitleCanvas() {
    const next = document.createElement("canvas");
    next.id = "subtitleCanvas";
    next.className = "subtitle-canvas";
    next.setAttribute("aria-hidden", "true");
    Object.assign(next.style, {
      position: "absolute",
      top: "0",
      left: "0",
      zIndex: "5",
      width: "100%",
      height: "100%",
      display: "block",
      pointerEvents: "none",
      background: "transparent"
    });
    if (subtitleCanvas?.isConnected) subtitleCanvas.replaceWith(next);
    else videoShell.insertBefore(next, videoPlaceholder);
    subtitleCanvas = next;
    subtitleLayoutSignature = "";
    return next;
  }
  
  function updateSubtitleCanvasLayout() {
    if (!subtitleCanvas) return false;
    const surfaceWidth = video.clientWidth || videoShell.clientWidth || 16;
    const surfaceHeight = video.clientHeight || videoShell.clientHeight || 9;
    const mediaWidth = video.videoWidth || surfaceWidth;
    const mediaHeight = video.videoHeight || surfaceHeight;
    const mediaRatio = mediaWidth / mediaHeight;
    const surfaceRatio = surfaceWidth / surfaceHeight;
    let width = surfaceWidth;
    let height = surfaceHeight;
    let left = 0;
    let top = 0;
    if (surfaceRatio > mediaRatio) {
      width = surfaceHeight * mediaRatio;
      left = (surfaceWidth - width) / 2;
    } else {
      height = surfaceWidth / mediaRatio;
      top = (surfaceHeight - height) / 2;
    }
    const layout = [left, top, width, height].map(Math.round);
    const signature = layout.join("x");
    if (signature === subtitleLayoutSignature) return false;
    subtitleLayoutSignature = signature;
    subtitleCanvas.style.left = `${layout[0]}px`;
    subtitleCanvas.style.top = `${layout[1]}px`;
    subtitleCanvas.style.width = `${layout[2]}px`;
    subtitleCanvas.style.height = `${layout[3]}px`;
    return true;
  }
  
  async function selectCaption(index) {
    const generation = ++subtitleGeneration;
    const previous = subtitleRenderer;
    subtitleRenderer = null;
    lastSubtitleFrame = "";
    lastSubtitleRenderAt = 0;
    if (previous) {
      try { await previous.destroy(); } catch {}
    }
    if (generation !== subtitleGeneration) return;
    const canvas = replaceSubtitleCanvas();
    if (index < 0 || !captionTracks[index]) return;
    const track = captionTracks[index];
    try {
      const renderer = new JASSUB({
        canvas,
        subUrl: track.url,
        workerUrl: "/vendor/jassub/worker.js",
        wasmUrl: "/vendor/jassub/jassub-worker.wasm",
        modernWasmUrl: "/vendor/jassub/jassub-worker-modern.wasm",
        queryFonts: "local",
        prescaleHeightLimit: 1080
      });
      await renderer.ready;
      if (generation !== subtitleGeneration) { await renderer.destroy(); return; }
      subtitleRenderer = renderer;
      updateSubtitleCanvasLayout();
      syncStatus.textContent = `Captions: ${track.label}`;
    } catch (error) {
      if (generation !== subtitleGeneration) return;
      captionSelect.value = "-1";
      report(`Could not render captions: ${error.message || error}`);
    }
  }
  
  function selectedId() {
    const track = captionTracks[Number(captionSelect.value)];
    return track?.id || track?.url || null;
  }

  function updateRemoveButton() {
    if (elements.removeCaptionButton) elements.removeCaptionButton.disabled = !selectedId();
  }

  function setCaptionTracks(tracks, { reset = false } = {}) {
    const next = Array.isArray(tracks) ? tracks : [];
    const previousId = selectedId();
    const nextSignature = JSON.stringify(next.map((track) => [track.id, track.url, track.label, track.lang, track.format]));
    if (nextSignature === captionSignature) return;
    captionSignature = nextSignature;
    captionTracks = next;
    captionSelect.replaceChildren();
    const off = document.createElement("option");
    off.value = "-1"; off.textContent = "Off"; captionSelect.appendChild(off);
    next.forEach((track, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `${track.label || `Track ${index + 1}`} (${String(track.originalFormat || track.format || "ASS").toUpperCase()})`;
      captionSelect.appendChild(option);
    });
    captionControl.hidden = next.length === 0;
    captionSelect.disabled = next.length === 0;
    const index = reset ? (next.length ? 0 : -1) : previousId == null ? -1 : next.findIndex((track) => (track.id || track.url) === previousId);
    captionSelect.value = String(index);
    updateRemoveButton();
    if (reset || previousId !== selectedId()) selectCaption(index);
  }

  function refreshSubtitlesAfterResize() {
    subtitleLayoutSignature = "";
    lastSubtitleFrame = "";
    cancelAnimationFrame(subtitleResizeFrame);
    clearTimeout(subtitleResizeTimer);
    subtitleResizeFrame = requestAnimationFrame(() => {
      updateSubtitleCanvasLayout();
      lastSubtitleFrame = "";
    });
    subtitleResizeTimer = setTimeout(() => {
      updateSubtitleCanvasLayout();
      lastSubtitleFrame = "";
      subtitleRenderer?.resize(true).catch(() => {});
    }, 180);
  }
  
  const subtitleLayoutObserver = globalThis.ResizeObserver
    ? new ResizeObserver(() => refreshSubtitlesAfterResize())
    : null;
  subtitleLayoutObserver?.observe(videoShell);
  if (!subtitleLayoutObserver) window.addEventListener("resize", refreshSubtitlesAfterResize);
  video.addEventListener("loadedmetadata", refreshSubtitlesAfterResize);
  window.addEventListener("orientationchange", refreshSubtitlesAfterResize);

  captionSelect.addEventListener("change", () => { updateRemoveButton(); selectCaption(Number(captionSelect.value)); });

  function renderSubtitleFrame(now) {
    requestAnimationFrame(renderSubtitleFrame);
    const renderer = subtitleRenderer;
    if (!renderer || document.hidden || renderer.busy) return;
  
    const paused = Boolean(video.paused);
    const targetFps = window.innerWidth < 900 ? 20 : 30;
    const frameInterval = 1000 / targetFps;
    if (!paused && now - lastSubtitleRenderAt < frameInterval) return;
  
    const width = video.videoWidth || videoShell.clientWidth || 16;
    const height = video.videoHeight || videoShell.clientHeight || 9;
    const mediaTime = Number(video.currentTime) || 0;
    const timeKey = paused ? mediaTime.toFixed(3) : Math.floor(mediaTime * targetFps);
    const signature = `${width}x${height}@${timeKey}`;
    if (signature === lastSubtitleFrame) return;
  
    lastSubtitleFrame = signature;
    lastSubtitleRenderAt = now;
    renderer.manualRender({
      expectedDisplayTime: now, width, height, mediaTime
    }, paused).catch(() => {
      if (subtitleRenderer === renderer) lastSubtitleFrame = "";
    });
  }
  requestAnimationFrame(renderSubtitleFrame);

  return { setTracks: setCaptionTracks, selectedId, refreshLayout: refreshSubtitlesAfterResize };
}
