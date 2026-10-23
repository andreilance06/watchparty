import { createJassubAdapter } from "./jassub-adapter.js";
import { createNativeCaptionMenu } from "./native-caption-menu.js";
import { updateCaptionStatus } from "./caption-status.js";

const STATUS_ID = "watchparty-caption-status";

export function createSubtitles({ elements, report, onAddCaptions = () => {} }) {
  const { video } = elements;
  let tracks = [], selected = null, adapter, sourceKey = "", initialized = false, pictureAvailable = false;
  let hasVideo = false, canAdd = false, status = "off", phase = null, noticeTimer, notice, noticeVisible = false;
  let registeredPlayer;
  const contents = new Map();
  const menu = createNativeCaptionMenu({ video, onSelect: select, onAdd: onAddCaptions, report });

  function clearNotice() {
    clearTimeout(noticeTimer); noticeTimer = undefined;
    video.hideOverlay?.(STATUS_ID);
    noticeVisible = false;
  }
  function preparationState(next, nextPhase = null) {
    status = next;
    phase = nextPhase;
    clearTimeout(noticeTimer); noticeTimer = undefined;
    if (next === "off") clearNotice();
    if (next !== "off") {
      if (!notice) {
        notice = document.createElement("div");
        notice.setAttribute("role", "status");
        notice.setAttribute("aria-live", "polite");
        Object.assign(notice.style, { position: "absolute", top: "12px", left: "12px", maxWidth: "calc(100% - 48px)",
          padding: "8px 12px", font: "inherit", fontSize: "13px", color: "var(--movi-controls-color)",
          background: "var(--movi-glass-bg)", border: "1px solid var(--movi-glass-border)",
          borderRadius: "var(--movi-radius-surface)", boxShadow: "var(--movi-shadow-lg)" });
      }
      updateCaptionStatus(notice, { status, phase, tracks });
      if (!noticeVisible) {
        video.showOverlay?.({ id: STATUS_ID, content: notice, placement: "fill", interactive: false });
        noticeVisible = true;
      }
      if (next !== "preparing") noticeTimer = setTimeout(clearNotice, 3000);
    }
    updateUi();
  }

  function loadContent(url) {
    if (!contents.has(url)) {
      const pending = fetch(url).then(async (response) => {
        if (!response.ok) throw new Error((await response.text?.()) || "This caption track could not be extracted. Add an external SRT, VTT, ASS, or SSA subtitle file.");
        if (tracks.some(track => track.id === selected && track.url === url)) {
          try { video.watchpartyCaptionMetrics = JSON.parse(response.headers?.get("X-WatchParty-Caption-Metrics") || "null"); } catch {}
        }
        return response.text();
      }).catch((error) => { if (contents.get(url) === pending) contents.delete(url); throw error; });
      contents.set(url, pending);
    }
    return contents.get(url);
  }
  function connect() {
    if (!adapter || adapter.destroyed) {
      registeredPlayer = null;
      const next = createJassubAdapter({ video, report, loadContent,
        isPictureReady: () => pictureAvailable,
        onState: (value, phase) => { if (adapter === next) preparationState(value, phase); } });
      adapter = next;
      video.showOverlay?.({ id: "watchparty-subtitles", content: adapter.surface, placement: "fill", interactive: false });
      // Keep a dedicated public overlay. Movi clears its built-in subtitle
      // container on seek/Off, which would detach a custom renderer's canvas.
      const mount = adapter.mount;
      const container = adapter.surface.parentNode || adapter.surface;
      adapter.mount = () => mount(container);
      adapter.mount();
    }
    // Preparation can start before Movi creates its player. Register when that
    // player becomes available, without rebuilding the prepared renderer.
    if (video.player !== registeredPlayer && typeof video.player?.setSubtitleRenderer === "function") {
      video.setSubtitleRenderer(adapter);
      registeredPlayer = video.player;
    }
    adapter.setDelay(video.subtitleDelay || 0);
    return adapter;
  }
  function updateUi() {
    menu.update({ tracks, selectedId: selected, status, phase, hasVideo, canAdd });
  }
  function select(id) {
    selected = tracks.some((track) => track.id === id) ? id : null;
    if (selected) connect().select(tracks.find((track) => track.id === selected));
    else { adapter?.select(null); preparationState("off"); }
    updateUi();
  }
  function setTracks(next, { reset = false, key } = {}) {
    const changed = key != null && key !== sourceKey;
    if (reset || changed) menu.close();
    if (changed) {
      sourceKey = key; contents.clear(); initialized = false; pictureAvailable = false; video.watchpartyCaptionMetrics = null;
      const old = adapter; adapter = null; old?.destroy();
      clearNotice(); status = "off"; phase = null;
    }
    tracks = (Array.isArray(next) ? next : []).map((track) => ({ ...track, id: track.id || track.url }));
    const previous = selected;
    if (reset) initialized = false;
    if (!initialized && tracks.length) { selected = tracks[0].id; initialized = true; }
    else if (!tracks.some((track) => track.id === selected)) selected = null;
    if (previous !== selected || reset || changed) {
      if (!selected) { adapter?.select(null); preparationState("off"); }
      else connect().select(tracks.find((track) => track.id === selected));
    }
    updateUi();
  }
  function ready() {
    video.player?.selectSubtitleTrack?.(null)?.catch?.(() => {});
    if (selected) {
      const old = adapter;
      connect();
      if (adapter !== old) adapter.select(tracks.find((track) => track.id === selected));
    }
    updateUi();
  }
  video.addEventListener("loadedmetadata", ready);
  video.addEventListener("trackschange", ready);
  function pictureReady() {
    pictureAvailable = true;
    ready();
    adapter?.refresh();
  }
  video.addEventListener("loadeddata", pictureReady);
  video.addEventListener("watchparty-picture-ready", pictureReady);
  const delayChanged = () => adapter?.setDelay(video.subtitleDelay || 0);
  const seeked = () => adapter?.clear();
  video.addEventListener("subtitledelaychange", delayChanged);
  video.addEventListener("seeked", seeked);
  return { setTracks, selectedId: () => selected, select, refreshLayout: () => adapter?.refresh(),
    sourceChanging() { pictureAvailable = false; adapter?.clear(); },
    setAvailability(value) {
      hasVideo = value.hasVideo ?? hasVideo;
      canAdd = value.canAdd ?? canAdd;
      updateUi();
    },
    destroy() {
      clearNotice(); menu.destroy(); adapter?.destroy();
      for (const type of ["loadedmetadata", "trackschange"]) video.removeEventListener(type, ready);
      for (const type of ["loadeddata", "watchparty-picture-ready"]) video.removeEventListener(type, pictureReady);
      video.removeEventListener("subtitledelaychange", delayChanged);
      video.removeEventListener("seeked", seeked);
    } };
}
