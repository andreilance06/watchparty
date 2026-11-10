import { createJassubAdapter } from "./jassub-adapter.js";
import { createNativeCaptionMenu } from "./native-caption-menu.js";
import { captionStatusText } from "./caption-status.js";
import { createPlaybackStatus } from "./playback-status.js";

export function createSubtitles({ elements, report, onAddCaptions = () => {}, onRemoveCaption = () => {}, playbackStatus }) {
  const { video } = elements;
  const statusCard = playbackStatus || createPlaybackStatus(video);
  let tracks = [], selected = null, adapter, sourceKey = "", initialized = false, pictureAvailable = false;
  let hasVideo = false, canAdd = false, canRemove = false, status = "off", phase = null;
  let registeredPlayer;
  const contents = new Map();
  const contentRequests = new Set();
  const menu = createNativeCaptionMenu({ video, onSelect: select, onAdd: onAddCaptions, onRemove: onRemoveCaption, report });

  function clearNotice() { statusCard.clear("captions"); }
  function preparationState(next, nextPhase = null) {
    status = next; phase = nextPhase;
    if (next === "off") clearNotice();
    else statusCard.set("captions", { text: captionStatusText({ status, phase, tracks }), pending: next === "preparing" });
    updateUi();
  }

  function loadContent(url) {
    if (!contents.has(url)) {
      const controller = new AbortController(); contentRequests.add(controller);
      const pending = fetch(url, { signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error((await response.text?.()) || "This caption track could not be extracted. Add an external SRT, VTT, ASS, or SSA subtitle file.");
        if (tracks.some(track => track.id === selected && track.url === url)) {
          try { video.watchpartyCaptionMetrics = JSON.parse(response.headers?.get("X-WatchParty-Caption-Metrics") || "null"); } catch {}
        }
        return response.text();
      }).catch((error) => { if (contents.get(url) === pending) contents.delete(url); throw error; })
        .finally(() => contentRequests.delete(controller));
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
    menu.update({ tracks, selectedId: selected, status, phase, hasVideo, canAdd, canRemove });
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
      canRemove = value.canRemove ?? canRemove;
      updateUi();
    },
    destroy() {
      for (const controller of contentRequests) controller.abort(); contentRequests.clear(); contents.clear();
      clearNotice(); menu.destroy(); adapter?.destroy();
      for (const type of ["loadedmetadata", "trackschange"]) video.removeEventListener(type, ready);
      for (const type of ["loadeddata", "watchparty-picture-ready"]) video.removeEventListener(type, pictureReady);
      video.removeEventListener("subtitledelaychange", delayChanged);
      video.removeEventListener("seeked", seeked);
    } };
}
