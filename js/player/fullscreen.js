export function createFullscreen({ elements, getHostPaused, afterResize }) {
  const { video, videoShell, fullscreenButton, syncStatus } = elements;
  let previousBodyOverflow = "";

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }
  
  function updateFullscreenUi() {
    const active = Boolean(fullscreenElement()) || videoShell.classList.contains("pseudo-fullscreen");
    fullscreenButton.setAttribute("aria-label", active ? "Exit fullscreen" : "Enter fullscreen");
    fullscreenButton.title = active ? "Exit fullscreen" : "Fullscreen";
    if (typeof video.applyFullscreenUiState === "function") video.applyFullscreenUiState(active);
    afterResize();
  }
  
  async function toggleFullscreenSurface() {
    if (fullscreenElement()) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      return;
    }
    if (videoShell.classList.contains("pseudo-fullscreen")) {
      videoShell.classList.remove("pseudo-fullscreen");
      document.body.style.overflow = previousBodyOverflow;
      updateFullscreenUi();
      return;
    }
    if (videoShell.requestFullscreen) {
      await videoShell.requestFullscreen();
      return;
    }
    if (videoShell.webkitRequestFullscreen) {
      videoShell.webkitRequestFullscreen();
      return;
    }
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    videoShell.classList.add("pseudo-fullscreen");
    updateFullscreenUi();
  }
  
  fullscreenButton.addEventListener("click", async () => {
    try {
      // Firefox Mobile blocks remote play() calls with sound until the viewer
      // performs a gesture. This click supplies that gesture without exposing
      // play/pause or seeking controls to the viewer.
      video.muted = false;
      if (!Number.isFinite(video.volume) || video.volume < 0.05) video.volume = 1;
      const playAttempt = !getHostPaused()
        ? video.play().catch(() => {})
        : Promise.resolve();
      await toggleFullscreenSurface();
      await playAttempt;
    } catch { syncStatus.textContent = "Fullscreen is not available in this browser"; }
  });
  
  // Movi normally fullscreens only its custom element. Keep its fullscreen
  // button, but route the request to the shell that also owns JASSUB's canvas.
  video.addEventListener("movi-fullscreen-request", (event) => {
    event.preventDefault();
    toggleFullscreenSurface().catch(() => {
      syncStatus.textContent = "Fullscreen is not available in this browser";
    });
  });

  document.addEventListener("fullscreenchange", updateFullscreenUi);
  document.addEventListener("webkitfullscreenchange", updateFullscreenUi);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && videoShell.classList.contains("pseudo-fullscreen")) {
      videoShell.classList.remove("pseudo-fullscreen");
      document.body.style.overflow = previousBodyOverflow;
      updateFullscreenUi();
    }
  });

  return { toggle: toggleFullscreenSurface, updateUi: updateFullscreenUi };
}
