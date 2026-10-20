// Movi 0.4.1 does not expose adaptive-loader pause/resume publicly. Isolate the
// pinned hls.js bridge here: holding an HTTP segment open while paused would
// otherwise exhaust hls.js retries and eventually destroy a healthy player.
export function createCompatibilityBuffer(video) {
  let loader, stopped = false, lastPaint = "";
  function update() {
    const next = video.player?.streamWrapper?.hls;
    if (next !== loader) { loader = next; stopped = false; lastPaint = ""; }
    const native = video.player?.getHLSVideoElement?.();
    // The wrapper stops its frame loop when paused. Canvas resize/fullscreen
    // clears WebGL, so repaint the retained native frame without playing it.
    if (native?.paused && native.readyState >= 2) {
      const canvas = video.getCanvas?.();
      const paint = `${canvas?.width}x${canvas?.height}@${native.currentTime}`;
      if (paint !== lastPaint) { lastPaint = paint; video.player?.streamWrapper?.renderFrame?.(); }
    } else lastPaint = "";
    if (!loader || typeof loader.stopLoad !== "function" || typeof loader.startLoad !== "function" || !native) return;
    const shouldLoad = !native.paused || native.seeking || native.readyState < 2;
    if (shouldLoad && stopped) { stopped = false; loader.startLoad(Number(native.currentTime) || 0); }
    else if (!shouldLoad && !stopped) { stopped = true; loader.stopLoad(); }
  }
  video.addEventListener("play", update);
  video.addEventListener("pause", update);
  video.addEventListener("seeking", update);
  video.addEventListener("seeked", update);
  return { update };
}
