const OVERLAY_ID = "watchparty-seek-frame";

// Movi 0.4.1 rebuilds its media clock/canvas on source changes. Keep its UI
// clock and duration stable without changing the real currentTime getter used
// by synchronization. These element-level hooks are intentionally isolated.
export function createSeekPresentation({ video, snapshot, settled, canBeginLocal = () => false, onTimeout = () => {} }) {
  let pending, image, timeout, callbackSurface, callbackId, paintFrame;
  const surface = () => video.player?.getHLSVideoElement?.() || video.player?.getVideoElement?.() || video;
  const uiClock = video._uiCurrentTime;
  const armSeek = video._armUiSeekTarget;
  const disposePlayer = video.dispose;
  let owner = video;
  while (owner && !Object.getOwnPropertyDescriptor(owner, "duration")) owner = Object.getPrototypeOf(owner);
  const ownDuration = Object.getOwnPropertyDescriptor(video, "duration");
  const duration = owner && Object.getOwnPropertyDescriptor(owner, "duration");
  const realDuration = () => duration?.get ? duration.get.call(video) : duration?.value || 0;
  video._uiCurrentTime = function(...args) { return pending ? pending.time : uiClock?.apply(this, args) ?? this.currentTime; };
  if (duration?.get && ownDuration?.configurable !== false) Object.defineProperty(video, "duration", {
    configurable: true, get: () => pending?.duration || realDuration()
  });
  if (armSeek) video._armUiSeekTarget = function(time, ...args) {
    if (canBeginLocal()) begin(time, snapshot()?.duration);
    return armSeek.call(this, time, ...args);
  };
  // Source replacement resets the visible labels directly in dispose(), before
  // its next UI tick. Restore them synchronously so that reset never paints.
  if (disposePlayer) video.dispose = function(...args) {
    try { return disposePlayer.apply(this, args); }
    finally { if (pending) refresh(); }
  };

  function refresh() {
    video.updateTimeDisplay?.(); video.updateProgressBar?.(); video.updateSeekAria?.();
  }
  function cancelFrame() {
    if (callbackId !== undefined) callbackSurface?.cancelVideoFrameCallback?.(callbackId);
    callbackSurface = undefined; callbackId = undefined;
    if (paintFrame !== undefined) cancelAnimationFrame(paintFrame);
    paintFrame = undefined;
  }
  function clear() {
    cancelFrame(); clearTimeout(timeout); pending = undefined;
    video.hideOverlay?.(OVERLAY_ID); image = undefined;
    video.watchpartySeekPresentation = null;
    refresh();
  }
  function capture() {
    if (image) return;
    const native = surface();
    const input = native !== video && native.readyState >= 2 ? native : video.getCanvas?.();
    const width = input?.videoWidth || input?.width, height = input?.videoHeight || input?.height;
    if (!(width > 0 && height > 0)) return;
    try {
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 1920 / width, 1080 / height);
      canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d"); if (!context) return;
      context.drawImage(input, 0, 0, canvas.width, canvas.height);
      Object.assign(canvas.style, { width: "100%", height: "100%", objectFit: "contain", background: "#050608", pointerEvents: "none" });
      canvas.setAttribute("aria-hidden", "true"); image = canvas;
      video.showOverlay?.({ id: OVERLAY_ID, content: image, placement: "fill", interactive: false });
      // The held video belongs below captions and other existing overlays.
      const overlay = image.parentNode;
      if (overlay?.parentNode) overlay.parentNode.insertBefore(overlay, overlay.parentNode.firstChild);
    } catch { /* A frame may be unavailable; retain the requested UI clock. */ }
  }
  function begin(time, knownDuration, replacing = false) {
    if (!Number.isFinite(time) || time < 0) return;
    if (!video.player || !uiClock && !video.getCanvas && !surface()?.requestVideoFrameCallback) return;
    const native = surface();
    if (!pending && !replacing && native.readyState >= 2 && !native.seeking && Math.abs(native.currentTime - time) < 0.0001) return;
    if (!pending) capture();
    const total = knownDuration || pending?.duration || realDuration();
    if (pending && pending.time === time && !replacing) { pending.duration = total; refresh(); return; }
    cancelFrame(); clearTimeout(timeout);
    pending = { time, duration: total, player: video.player, replacing, presented: false };
    video.watchpartySeekPresentation = { time, duration: total, holdingFrame: Boolean(image) };
    timeout = setTimeout(() => { if (pending) { clear(); onTimeout(); } }, 10000);
    refresh(); update();
  }
  function atTarget(time) {
    const fps = snapshot()?.mediaInfo?.fps || 30;
    return Number.isFinite(time) && Math.abs(time - pending.time) <= Math.max(0.25, 2 / fps);
  }
  function completeAfterPaint(attempt) {
    if (paintFrame !== undefined) return;
    paintFrame = requestAnimationFrame(() => {
      paintFrame = undefined;
      if (pending === attempt && pending.presented && settled() && !video.isSeeking && !surface().seeking && atTarget(surface().currentTime)) clear();
    });
  }
  function update() {
    if (!pending) return;
    const native = surface(), player = video.player, attempt = pending;
    if (!player || pending.replacing && player === pending.player) return;
    if (callbackSurface && callbackSurface !== native) cancelFrame();
    if (callbackId === undefined && typeof native.requestVideoFrameCallback === "function") {
      callbackSurface = native;
      callbackId = native.requestVideoFrameCallback((_now, metadata) => {
        if (pending !== attempt || player !== video.player || native !== surface()) return;
        callbackId = undefined;
        if (atTarget(metadata.mediaTime)) {
          pending.presented = true;
          player.streamWrapper?.renderFrame?.();
          completeAfterPaint(attempt);
        } else update();
      });
    }
    // Paused media can present its only frame before callback registration,
    // especially after rapid seeks. Repaint HLS's canvas; native playback can
    // expose the already-decoded frame directly on the next animation frame.
    if (settled() && !video.isSeeking && !native.seeking && native.readyState >= 2 && atTarget(native.currentTime)) {
      if (typeof player.streamWrapper?.renderFrame === "function") {
        player.streamWrapper.renderFrame(); pending.presented = true;
      } else if (native !== video && player.getVideoElement?.() === native) pending.presented = true;
    }
    if (pending.presented && settled()) completeAfterPaint(attempt);
  }
  return { begin, update, clear, active: () => Boolean(pending), dispose() {
    clear();
    if (uiClock) video._uiCurrentTime = uiClock; else delete video._uiCurrentTime;
    if (armSeek) video._armUiSeekTarget = armSeek;
    if (disposePlayer) video.dispose = disposePlayer;
    if (duration?.get) { if (ownDuration) Object.defineProperty(video, "duration", ownDuration); else delete video.duration; }
  } };
}
