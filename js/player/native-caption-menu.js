import { captionStatusText, updateCaptionStatus } from "./caption-status.js";

// Movi 0.4.1 has no host-managed subtitle-menu API. Keep the element-level
// hooks here; do not replace player/decoder methods or edit its generated bundle.
export function createNativeCaptionMenu({ video, onSelect, onAdd, report }) {
  let state = { tracks: [], selectedId: null, status: "off", phase: null, hasVideo: false, canAdd: false };
  let destroyed = false, pickerPending = false;
  const hooks = new Map(), containers = new Map(), statuses = new Map();
  const root = () => video.shadowRoot;
  const contextRoot = () => video.contextMenuRoot?.() || root();
  const available = () => state.hasVideo && (state.tracks.length > 0 || state.canAdd) && !video.isControlDisabled?.("cc");
  const name = track => track.title || track.label || "Captions";
  const details = track => [track.lang || "und", track.default && "Default", track.forced && "Forced"].filter(Boolean).join(" · ");
  const button = () => root()?.querySelector(".movi-subtitle-track-btn");

  function hook(method, replacement) {
    const original = video[method], descriptor = Object.getOwnPropertyDescriptor(video, method);
    const wrapped = (...args) => replacement(original?.bind(video), ...args);
    hooks.set(method, { descriptor, wrapped });
    video[method] = wrapped;
  }
  function close() {
    video.closeAllBottomMenus?.();
    video.closeSettingsPage?.(false);
    video._hideContextMenu?.();
  }
  function focusButton() { if (!destroyed && available()) button()?.focus(); }
  function activate(event, row) {
    event.preventDefault(); event.stopPropagation();
    if (!available()) return;
    if (row.dataset.roomCaptionKey === "add") {
      if (!state.canAdd || pickerPending) return;
      close();
      pickerPending = true;
      // Open synchronously inside the user gesture. The returned promise ends
      // on either cancellation or completed processing, with no trigger rebuild.
      try {
        Promise.resolve(onAdd()).catch(error => report(error.message || String(error))).finally(() => {
          pickerPending = false; focusButton();
        });
      } catch (error) { pickerPending = false; report(error.message || String(error)); focusButton(); }
    } else {
      close();
      onSelect(row.dataset.roomCaptionId || null);
      focusButton();
    }
  }
  function keydown(event, row) {
    if (["Enter", " "].includes(event.key)) { activate(event, row); return; }
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); close(); focusButton(); return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const rows = [...row.parentNode.children].filter(child => child.dataset.roomCaptionKey);
    const index = rows.indexOf(row);
    const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 :
      (index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
    rows[next]?.focus();
  }
  function makeRow(context) {
    const row = document.createElement("div");
    row.className = context ? "movi-context-menu-item" : "movi-subtitle-track-item";
    row.tabIndex = 0;
    const icon = document.createElement("span"), label = document.createElement("span"), info = document.createElement("span");
    label.className = context ? "movi-context-menu-label" : "movi-subtitle-track-label";
    info.className = "movi-subtitle-track-info";
    row.append(icon, label, info);
    if (!context) {
      const check = document.createElement("span");
      check.innerHTML = video.constructor.TRACK_ICON_CHECK || "✓";
      check.className = "movi-track-item-check";
      check.setAttribute("aria-hidden", "true");
      row.appendChild(check);
    }
    row.addEventListener("click", event => activate(event, row));
    row.addEventListener("keydown", event => keydown(event, row));
    return row;
  }
  function renderRows(container, context = false) {
    if (!container) return;
    let rows = containers.get(container);
    if (!rows) { rows = new Map(); containers.set(container, rows); }
    let status = statuses.get(container);
    if (!status) {
      status = document.createElement("div");
      status.className = "movi-track-menu-footer";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      statuses.set(container, status);
    }
    const choices = [{ key: "off", label: "Off", selected: !state.selectedId }, ...state.tracks.map(track => ({
      key: `track:${track.id}`, id: track.id, label: name(track), details: details(track), selected: track.id === state.selectedId
    }))];
    if (state.canAdd) choices.push({ key: "add", label: "Add captions" });
    const retained = new Set();
    let index = context ? 1 : 0;
    for (const choice of choices) {
      let row = rows.get(choice.key);
      if (!row) { row = makeRow(context); rows.set(choice.key, row); }
      row.dataset.roomCaptionKey = choice.key;
      row.dataset.roomCaptionId = choice.id || "";
      row.classList.toggle(context ? "movi-context-menu-active" : "movi-subtitle-track-active", Boolean(choice.selected));
      row.classList.toggle("movi-subtitle-pick-item", choice.key === "add");
      row.setAttribute("role", choice.key === "add" ? "menuitem" : "menuitemradio");
      if (choice.key === "add") row.removeAttribute("aria-checked");
      else row.setAttribute("aria-checked", String(Boolean(choice.selected)));
      row.children[0].innerHTML = choice.key === "off" ? video.constructor.TRACK_ICON_OFF || "" :
        choice.key === "add" ? "+" : video.constructor.TRACK_ICON_SUBTITLE || "";
      row.children[0].setAttribute("aria-hidden", "true");
      row.children[1].textContent = choice.label;
      row.children[2].textContent = choice.details || "";
      row.title = [choice.label, choice.details].filter(Boolean).join(" · ");
      if (container.children[index] !== row) container.insertBefore(row, container.children[index] || null);
      index++; retained.add(row);
    }
    for (const child of [...container.children]) {
      if (!retained.has(child) && child !== status && !(context && child.dataset.action === "back")) child.remove();
    }
    for (const [key, row] of rows) if (!retained.has(row)) rows.delete(key);
    updateCaptionStatus(status, state);
    if (container.children[container.children.length - 1] !== status) container.appendChild(status);
    container.setAttribute("role", "menu");
    container.setAttribute("aria-label", "Captions");
  }
  function syncAvailability() {
    const visible = available(), cc = button();
    // Native/HLS engines otherwise hide the entire CC container in CSS when
    // their own decoder has no text tracks. Our room tracks use JASSUB.
    const changed = video.classList.contains("movi-native-subs") !== visible;
    video.classList.toggle("movi-native-subs", visible);
    if (changed) video.syncMenuPortalAudioClasses?.();
    const container = root()?.querySelector(".movi-subtitle-track-container");
    if (container) container.style.display = visible ? "flex" : "none";
    if (cc) {
      cc.style.display = visible ? "flex" : "none"; cc.disabled = !visible;
      cc.style.opacity = "1"; cc.style.pointerEvents = visible ? "auto" : "none";
      cc.setAttribute("aria-haspopup", "menu");
      cc.setAttribute("aria-expanded", String(Boolean(root()?.querySelector(".movi-subtitle-track-menu.is-open"))));
    }
    for (const selector of [".movi-subtitle-customize-btn", ".movi-subtitle-browse-btn"]) {
      const action = root()?.querySelector(selector);
      if (action) action.style.display = "none";
    }
    root()?.querySelector(".movi-icon-subtitle")?.style.setProperty("display", state.selectedId ? "none" : "block");
    root()?.querySelector(".movi-icon-subtitle-filled")?.style.setProperty("display", state.selectedId ? "block" : "none");
  }
  function renderList() {
    renderRows(root()?.querySelector(".movi-subtitle-track-list"));
    const footer = root()?.querySelector(".movi-subtitle-track-footer");
    if (footer) footer.textContent = "";
    syncAvailability();
  }
  function renderContext(menu = contextRoot()?.querySelector(".movi-context-menu")) {
    const row = menu?.querySelector(".movi-context-menu-item-subtitle");
    const divider = menu?.querySelector(".movi-context-menu-divider-subtitle");
    const submenu = contextRoot()?.querySelector(".movi-context-menu-submenu-subtitle");
    if (!row || !submenu) return;
    const visible = available();
    row.style.display = visible ? "flex" : "none";
    row.style.opacity = "1"; row.style.pointerEvents = visible ? "auto" : "none";
    if (divider) divider.style.display = visible ? "block" : "none";
    if (!visible) { submenu.style.display = "none"; return; }
    submenu.style.removeProperty("display");
    if (!submenu.querySelector('[data-action="back"]')) {
      const back = document.createElement("div");
      back.className = "movi-context-menu-item movi-context-menu-back";
      back.dataset.action = "back"; back.textContent = "Back";
      submenu.insertBefore(back, submenu.children[0] || null);
    }
    renderRows(submenu, true);
    submenu.setAttribute("aria-description", captionStatusText(state));
    video.setupSubmenuHover?.(row, submenu);
    for (const item of submenu.children) { item.style.opacity = "1"; item.style.pointerEvents = "auto"; }
  }

  hook("updateSubtitleTrackMenu", () => renderList());
  hook("updateContextMenuContent", (original, menu) => {
    const focused = contextRoot()?.activeElement;
    const key = focused?.dataset.roomCaptionKey;
    original?.(menu);
    renderContext(menu);
    if (key) [...(contextRoot()?.querySelector(".movi-context-menu-submenu-subtitle")?.children || [])]
      .find(row => row.dataset.roomCaptionKey === key)?.focus();
  });
  hook("settingsRowValue", (original, page) => page === "subtitles" ?
    state.tracks.filter(track => track.id === state.selectedId).map(name)[0] || "Off" : original?.(page));
  hook("settingsRowAvailable", (original, selector, items) => selector === ".movi-subtitle-track-container" ?
    available() : original?.(selector, items));
  hook("updateControlsState", original => { original?.(); syncAvailability(); renderContext(); });
  hook("setBottomMenuOpen", (original, target, open) => {
    original?.(target, open);
    if (target === root()?.querySelector(".movi-subtitle-track-menu")) {
      button()?.setAttribute("aria-expanded", String(open));
      if (open) video.showControls?.();
    }
  });
  hook("hideControls", original => {
    const captionsOpen = root()?.querySelector(".movi-subtitle-track-menu.is-open");
    const settingsOpen = video._settingsPage === "subtitles" && root()?.querySelector(".movi-settings-menu.is-open");
    if (captionsOpen || settingsOpen) video.showControls?.(); else original?.();
  });
  hook("openSubtitleFilePicker", () => {
    if (state.canAdd) activate({ preventDefault() {}, stopPropagation() {} }, { dataset: { roomCaptionKey: "add" } });
  });
  const handleButtonKey = event => {
    if (event.target !== button() || !["ArrowDown", "ArrowUp"].includes(event.key) || !available()) return;
    event.preventDefault(); event.stopPropagation();
    const menu = root().querySelector(".movi-subtitle-track-menu");
    if (!video.isBottomMenuOpen?.(menu)) button().click();
    const list = root().querySelector(".movi-subtitle-track-list");
    const rows = [...(list?.children || [])].filter(row => row.dataset.roomCaptionKey);
    (event.key === "ArrowUp" ? rows.at(-1) : rows[0])?.focus();
  };
  root()?.addEventListener("keydown", handleButtonKey, true);
  const cycleTrack = event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey ||
        video.getAttribute("nohotkeys") !== null || !available()) return;
    const target = event.composedPath?.()[0] || event.target;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName) || target?.isContentEditable) return;
    const shortcuts = video.getShortcut?.("subtitles") || ["v"];
    if (!shortcuts.includes(event.key.toLowerCase())) return;
    event.preventDefault(); event.stopPropagation();
    const index = state.tracks.findIndex(track => track.id === state.selectedId);
    const next = state.tracks[index + 1];
    onSelect(next?.id || null);
    video.showOsd?.(next ? name(next) : "Subtitles Off");
  };
  video.addEventListener("keydown", cycleTrack, true);
  return {
    close,
    update(next) {
      if (destroyed) return;
      const previous = available();
      state = { ...state, ...next };
      if (previous && !available()) close();
      renderList(); renderContext();
      video.refreshOpenSettingsSurfaces?.();
      video.syncMobileExtras?.();
    },
    destroy() {
      if (destroyed) return;
      close(); destroyed = true;
      root()?.removeEventListener("keydown", handleButtonKey, true);
      video.removeEventListener("keydown", cycleTrack, true);
      for (const [method, { descriptor, wrapped }] of hooks) if (video[method] === wrapped) {
        if (descriptor) Object.defineProperty(video, method, descriptor); else delete video[method];
      }
      containers.clear(); statuses.clear();
    }
  };
}
