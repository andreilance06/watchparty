import { createJassubAdapter } from "./jassub-adapter.js";

const CONTROL_ID = "watchparty-captions";
const MENU_ID = "watchparty-caption-menu";
const CAPTIONS_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="2.5" y="4.5" width="19" height="15" rx="3"/><path d="M10 9.5a2.5 2.5 0 1 0 0 5m8-5a2.5 2.5 0 1 0 0 5"/></svg>';

export function createSubtitles({ elements, report }) {
  const { video, removeCaptionButton } = elements;
  let tracks = [], selected = null, adapter, sourceKey = "", initialized = false, canLoad = false;
  const contents = new Map();
  const panel = document.createElement("div");
  Object.assign(panel.style, { padding: "14px", background: "#171722", color: "white", borderRadius: "10px",
    font: "14px system-ui", maxHeight: "60vh", overflow: "auto", minWidth: "200px" });

  function loadContent(url) {
    if (!contents.has(url)) {
      const pending = fetch(url).then((response) => {
        if (!response.ok) throw new Error("This caption track could not be extracted.");
        return response.text();
      }).catch((error) => { contents.delete(url); throw error; });
      contents.set(url, pending);
    }
    return contents.get(url);
  }
  function connect() {
    if (!adapter || adapter.destroyed) {
      adapter = createJassubAdapter({ video, report, loadContent });
      video.showOverlay?.({ id: "watchparty-subtitles", content: adapter.surface, placement: "fill", interactive: false });
      // Keep a dedicated public overlay. Movi clears its built-in subtitle
      // container on seek/Off, which would detach a custom renderer's canvas.
      const mount = adapter.mount;
      const container = adapter.surface.parentNode || adapter.surface;
      adapter.mount = () => mount(container);
      adapter.mount();
      // Native/HLS wrappers expose the element method but don't implement it.
      // Their public overlay uses the adapter's clock bridge instead.
      if (typeof video.player?.setSubtitleRenderer === "function") video.setSubtitleRenderer(adapter);
    }
    return adapter;
  }
  function updateUi() {
    if (removeCaptionButton) removeCaptionButton.disabled = !selected;
    const items = [{ id: "off", label: "Off" }, ...tracks.map((track) => ({ id: track.id, label: track.label || "Captions" }))];
    if (!tracks.length) { closePanel(); video.removeControl?.(CONTROL_ID); return; }
    video.addControl?.({ id: CONTROL_ID, label: "Captions", title: "Captions", icon: CAPTIONS_ICON,
      placement: "both", side: "right", before: "settings",
      items, value: selected || "off", onPick: (id) => select(id === "off" ? null : id), onSelect: togglePanel });
    if (video.isOverlayVisible?.(MENU_ID)) renderPanel();
  }
  function removeDismissListeners() {
    document.removeEventListener("click", dismissOutside, true);
    document.removeEventListener("touchend", dismissOutside, true);
    document.removeEventListener("keydown", dismissEscape, true);
  }
  function closePanel() {
    video.hideOverlay?.(MENU_ID);
    removeDismissListeners();
  }
  function dismissOutside(event) {
    const path = event.composedPath();
    if (path.includes(panel) || path.some(node => node.dataset?.customControl === CONTROL_ID)) return;
    closePanel();
    const control = path.some(node => node.matches?.('button, input, select, textarea, a, [role="button"], [role="slider"], [contenteditable="true"]'));
    if (path.includes(video) && !control) {
      // Consume picture taps used to dismiss the panel, before Movi can turn
      // the same gesture into a play/pause action (including touch gestures).
      event.preventDefault();
      event.stopPropagation();
    }
  }
  function dismissEscape(event) {
    if (event.key !== "Escape") return;
    closePanel();
    event.preventDefault();
    event.stopPropagation();
    video.focus();
  }
  function renderPanel() {
    panel.replaceChildren();
    for (const track of [null, ...tracks]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${(track?.id || null) === selected ? "✓ " : ""}${track?.label || "Off"}`;
      Object.assign(button.style, { display: "block", width: "100%", textAlign: "left", padding: "9px", background: "transparent",
        color: "inherit", border: "0", cursor: "pointer", font: "inherit" });
      button.addEventListener("click", () => { select(track?.id || null); video.focus(); });
      panel.appendChild(button);
    }
  }
  function togglePanel() {
    if (video.isOverlayVisible?.(MENU_ID)) { closePanel(); return; }
    renderPanel();
    video.showOverlay?.({ id: MENU_ID, content: panel, placement: "bottom-end", dismissOn: ["escape"], onDismiss: removeDismissListeners });
    document.addEventListener("click", dismissOutside, true);
    document.addEventListener("touchend", dismissOutside, { capture: true, passive: false });
    document.addEventListener("keydown", dismissEscape, true);
  }
  function select(id) {
    closePanel();
    selected = tracks.some((track) => track.id === id) ? id : null;
    connect().select(tracks.find((track) => track.id === selected) || null);
    updateUi();
  }
  function setTracks(next, { reset = false, key } = {}) {
    if (reset || key != null && key !== sourceKey) closePanel();
    if (key != null && key !== sourceKey) {
      sourceKey = key; contents.clear(); initialized = false; canLoad = false;
      adapter?.destroy(); adapter = null;
    }
    tracks = (Array.isArray(next) ? next : []).map((track) => ({ ...track, id: track.id || track.url }));
    const previous = selected;
    if (reset) initialized = false;
    if (!initialized && tracks.length) { selected = tracks[0].id; initialized = true; }
    else if (!tracks.some((track) => track.id === selected)) selected = null;
    if (previous !== selected || reset) {
      if (!selected) adapter?.select(null);
      else if (canLoad) connect().select(tracks.find((track) => track.id === selected));
    }
    updateUi();
  }
  function ready() {
    video.player?.selectSubtitleTrack?.(null)?.catch?.(() => {});
    if (canLoad) {
      const old = adapter;
      connect();
      if (adapter !== old && selected) adapter.select(tracks.find((track) => track.id === selected));
    }
    updateUi();
  }
  video.addEventListener("loadedmetadata", ready);
  video.addEventListener("trackschange", ready);
  function pictureReady() {
    canLoad = true;
    if (selected) connect().select(tracks.find((track) => track.id === selected));
    ready();
  }
  video.addEventListener("loadeddata", pictureReady);
  video.addEventListener("watchparty-picture-ready", pictureReady);
  video.addEventListener("subtitledelaychange", () => adapter?.setDelay(video.subtitleDelay || 0));
  video.addEventListener("seeked", () => adapter?.clear());
  return { setTracks, selectedId: () => selected, select, refreshLayout: () => adapter?.refresh() };
}
