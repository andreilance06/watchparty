const CONTROL_ID = "watchparty-playback-rate";

// Keep sync corrections out of Movi's large OSD without changing its bundle.
export function createPlaybackRateDisplay(video) {
  let silent = false, label;
  const showOSD = video.showOSD?.bind(video);
  video.showOSD = (icon, text, ...args) => {
    if (silent && text === `${video.playbackRate}x`) return;
    return showOSD?.(icon, text, ...args);
  };

  function update() {
    const next = `${Number((video.playbackRate || 1).toFixed(2))}×`;
    if (next === label) return;
    label = next;
    video.addControl?.({ id: CONTROL_ID, label, title: "Current playback speed", placement: "bar", side: "left", after: "time" });
    const indicator = video.shadowRoot?.querySelector(`[data-custom-control="${CONTROL_ID}"]`);
    if (indicator) {
      indicator.setAttribute("role", "status");
      indicator.setAttribute("aria-label", `Playback speed ${label}`);
      indicator.setAttribute("tabindex", "-1");
      indicator.style.cssText = "pointer-events:none;font-variant-numeric:tabular-nums;min-width:3.5em";
    }
  }
  video.addEventListener("ratechange", update);
  update();
  return {
    apply(rate) {
      silent = true;
      try { video.playbackRate = rate; }
      finally { silent = false; update(); }
    }
  };
}
