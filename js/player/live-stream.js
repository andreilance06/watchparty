// Movi 0.4.1 renders srcObject under its own UI, but hasMediaSource omits it.
// Keep that pinned-version compatibility hook here, outside the vendor bundle.
export function createLiveStreamPlayback({ video, attention, isActive, onReady, onWaiting }) {
  let stream = null, local = false, previousMuted = false, playAttempt = 0;
  const hooks = [];
  function hook(name, replacement) {
    const original = video[name];
    if (typeof original !== "function") return;
    const descriptor = Object.getOwnPropertyDescriptor(video, name);
    const wrapped = (...args) => replacement(original.bind(video), ...args);
    video[name] = wrapped;
    hooks.push(() => {
      if (video[name] !== wrapped) return;
      if (descriptor) Object.defineProperty(video, name, descriptor);
      else delete video[name];
    });
  }
  hook("hasMediaSource", original => Boolean(stream) || original());
  // Native fallback suppresses all visual settings, although CSS object-fit
  // works on its video surface. Expose only that live-safe setting.
  hook("isControlAvailable", (original, control) => stream && control === "aspect"
    ? !video.isControlDisabled?.("aspect") : original(control));
  hook("updateFitMode", (original, ...args) => {
    const result = original(...args);
    if (stream && video.video) video.video.style.objectFit = video.posterObjectFit();
    return result;
  });

  function detach() {
    playAttempt++;
    if (!stream) return;
    stream = null; local = false;
    video.srcObject = null;
    video.muted = previousMuted;
    attention?.setPlaybackBlocked?.(false);
  }

  function play() {
    if (!stream || !isActive()) return;
    const attempt = ++playAttempt;
    Promise.resolve().then(() => {
      if (attempt === playAttempt) return video.play();
    }).then(() => {
      if (attempt === playAttempt) attention?.setPlaybackBlocked?.(false);
    }).catch(() => {
      if (attempt === playAttempt) attention?.setPlaybackBlocked?.(true);
    });
  }

  function setStream(next, isLocal = false) {
    if (!isActive() || next === stream && isLocal === local) return;
    detach();
    if (!next) {
      video.src = ""; video.style.visibility = "hidden";
      onWaiting();
      return;
    }
    stream = next; local = isLocal; previousMuted = video.muted;
    // Capture and peer ownership stay with screen-share.js. Never stop tracks here.
    video.srcObject = stream;
    video.updateFitMode?.();
    video.muted = local;
    if (!Number.isFinite(video.volume)) video.volume = 1;
    if (video.playbackRate !== 1) video.playbackRate = 1;
    video.loop = false;
    video.controls = true; video.style.visibility = "";
    onReady();
    play();
  }

  return { setStream, play, detach, destroy() {
    detach();
    for (const restore of hooks.reverse()) restore();
  } };
}
