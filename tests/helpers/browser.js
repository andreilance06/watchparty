// Lightweight DOM/transport doubles for module wiring tests; not a browser renderer.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");

class EventTargetDouble {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn, options = {}) {
    const list = this.listeners.get(type) || [];
    list.push({ fn, once: options.once }); this.listeners.set(type, list);
  }
  removeEventListener(type, fn) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item.fn !== fn));
  }
  dispatchEvent(event) { return !this.dispatch(event.type, event).defaultPrevented; }
  dispatch(type, properties = {}) {
    const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; }, ...properties };
    for (const item of [...(this.listeners.get(type) || [])]) {
      if (item.once) this.removeEventListener(type, item.fn);
      item.fn(event);
    }
    return event;
  }
}

class ElementDouble extends EventTargetDouble {
  constructor(tag = "div") {
    super(); this.tagName = tag; this.children = []; this.attributes = new Map();
    this.style = { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } };
    this.dataset = {}; this.value = ""; this.textContent = "";
    this.hidden = false; this.disabled = false; this.parentNode = null;
    this.clientWidth = 640; this.clientHeight = 360; this.connected = false;
    const classes = new Set();
    Object.defineProperty(this, "className", {
      get: () => [...classes].join(" "),
      set: value => { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach(name => classes.add(name)); }
    });
    this.classList = {
      contains: (name) => classes.has(name),
      add: (name) => classes.add(name), remove: (name) => classes.delete(name),
      toggle: (name, on) => { const enabled = on ?? !classes.has(name); if (enabled) classes.add(name); else classes.delete(name); }
    };
  }
  get isConnected() { return this.connected || !!this.parentNode?.isConnected; }
  get scrollHeight() { return this.children.length * 30; }
  appendChild(child) { child.remove(); child.parentNode = this; this.children.push(child); return child; }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  insertBefore(child, before) {
    child.remove(); child.parentNode = this;
    const index = this.children.indexOf(before); this.children.splice(index < 0 ? this.children.length : index, 0, child);
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
  replaceWith(next) { const parent = this.parentNode; parent.insertBefore(next, this); this.remove(); }
  replaceChildren(...next) { this.children.forEach((child) => { child.parentNode = null; }); this.children = []; this.append(...next); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  toggleAttribute(name, on) { if (on) this.setAttribute(name, ""); else this.removeAttribute(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  querySelectorAll(selector) {
    if (selector === "source[data-watchparty-source]") return this.children.filter((child) => child.tagName === "source" && "watchpartySource" in child.dataset);
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.specialChildren?.[selector] || this.querySelectorAll(selector)[0] || null; }
  matches(selector) {
    const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attribute) {
      const key = attribute[1].replace(/^data-/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      const value = attribute[1].startsWith('data-') ? this.dataset[key] : this.getAttribute(attribute[1]);
      return value != null && (attribute[2] === undefined || value === attribute[2]);
    }
    if (selector.startsWith('.')) return selector.slice(1).split('.').every(name => this.classList.contains(name));
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  getBoundingClientRect() {
    return { top: 0, left: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight };
  }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  focus() { this.focused = true; let root = this; while (root.parentNode) root = root.parentNode; root.activeElement = this; }
  click() { this.dispatch("click"); }
}

function createBrowserDouble({ storageFailure, rendererReady, autoContinuePublic = true,
  assessPlayback = async () => ({ playable: true, smooth: true, video: { decoder: "hardware" } }) } = {}) {
  const elements = new Map();
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  for (const match of html.matchAll(/id="([^"]+)"/g)) {
    const element = new ElementDouble(); element.id = match[1]; element.connected = true;
    elements.set(match[1], element);
  }
  const document = new EventTargetDouble();
  document.documentElement = new ElementDouble("html");
  document.querySelector = (selector) => elements.get(selector.slice(1));
  document.createElement = (tag) => new ElementDouble(tag);
  document.body = new ElementDouble("body"); document.body.connected = true;
  document.hidden = false;
  const placeholder = elements.get("videoPlaceholder");
  placeholder.specialChildren = { strong: new ElementDouble("strong"), "span:last-child": new ElementDouble("span") };
  const shell = elements.get("videoShell"); shell.appendChild(placeholder);
  shell.requestFullscreen = async () => { document.fullscreenElement = shell; document.dispatch("fullscreenchange"); };
  document.exitFullscreen = async () => { document.fullscreenElement = null; document.dispatch("fullscreenchange"); };
  const video = elements.get("video");
  Object.assign(video, { paused: true, currentTime: 0, readyState: 1, playbackRate: 1, muted: false, volume: 1, videoWidth: 1280, videoHeight: 720 });
  video.play = async () => { video.paused = false; video.dispatch("play"); };
  video.pause = () => { if (!video.paused) { video.paused = true; video.dispatch("pause"); } };
  video.applyFullscreenUiState = (active) => { video.fullscreenUiActive = active; };
  const window = new EventTargetDouble(); window.innerWidth = 1000; window.innerHeight = 800;
  const sockets = [], renderers = [], requests = [], timers = new Map(), frames = new Map(), storage = new Map();
  video.customControls = new Map(); video.overlays = new Map();
  video.addControl = (spec) => video.customControls.set(spec.id, spec);
  video.removeControl = (id) => video.customControls.delete(id);
  video.showOverlay = (spec) => { video.hideOverlay(spec.id); video.overlays.set(spec.id, spec); video.appendChild(spec.content); };
  video.hideOverlay = (id) => {
    const overlay = video.overlays.get(id);
    if (!overlay) return;
    overlay.content.remove(); video.overlays.delete(id); overlay.onDismiss?.('host');
  };
  video.isOverlayVisible = (id) => video.overlays.has(id);
  video.setSubtitleRenderer = (renderer) => { video.subtitleRenderer = renderer; };
  // Native Movi surfaces for application bridge tests. Real menu gestures,
  // layout, animations, and decoding still require the bundled player/browser.
  const shadow = video.shadowRoot = new ElementDouble('shadow-root');
  shadow.connected = true;
  const native = (className, parent = shadow) => { const node = new ElementDouble(); node.className = className; parent.appendChild(node); return node; };
  const captionContainer = native('movi-subtitle-track-container');
  const captionButton = native('movi-subtitle-track-btn', captionContainer);
  native('movi-icon-subtitle', captionButton); native('movi-icon-subtitle-filled', captionButton);
  const captionMenu = native('movi-subtitle-track-menu', captionContainer); captionMenu.style.display = 'none';
  native('movi-subtitle-customize-btn', captionMenu); native('movi-subtitle-browse-btn', captionMenu);
  native('movi-subtitle-track-list', captionMenu); native('movi-subtitle-track-footer', captionMenu);
  const contextMenu = native('movi-context-menu'); contextMenu.style.display = 'none';
  native('movi-context-menu-item-subtitle', contextMenu); native('movi-context-menu-divider-subtitle', contextMenu);
  native('movi-context-menu-submenu-subtitle');
  video.contextMenuRoot = () => shadow;
  video.isControlDisabled = id => (video.getAttribute('controlslist') || '').split(' ').includes(`no${id}`);
  video.updateSubtitleTrackMenu = () => {};
  video.updateContextMenuContent = () => {};
  video.updateControlsState = () => {};
  video.settingsRowValue = page => page;
  video.settingsRowAvailable = () => false;
  video.openSubtitleFilePicker = () => {};
  video.refreshOpenSettingsSurfaces = () => {};
  video.showControls = () => shadow.classList.remove('hidden-controls');
  video.hideControls = () => shadow.classList.add('hidden-controls');
  video.setBottomMenuOpen = (menu, open) => { menu.classList.toggle('is-open', open); menu.style.display = open ? '' : 'none'; };
  video.isBottomMenuOpen = menu => menu.classList.contains('is-open');
  video.closeAllBottomMenus = () => video.setBottomMenuOpen(captionMenu, false);
  video._hideContextMenu = () => { contextMenu.style.display = 'none'; };
  captionButton.addEventListener('click', () => { if (!captionButton.disabled) {
    video.setBottomMenuOpen(captionMenu, !video.isBottomMenuOpen(captionMenu)); video.updateSubtitleTrackMenu();
  } });
  let nextId = 1;
  class WebSocketDouble extends EventTargetDouble {
    static OPEN = 1;
    constructor(url) { super(); this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
    open() { this.readyState = 1; this.dispatch("open"); }
    send(text) { this.sent.push(typeof text === "string" ? JSON.parse(text) : text); }
    receive(message) { this.dispatch("message", { data: JSON.stringify(message) }); }
    close() { this.readyState = 3; this.dispatch("close"); }
  }
  class SubtitleRendererDouble {
    constructor(options) { this.options = options; this.ready = rendererReady || Promise.resolve(); this.busy = false; renderers.push(this); }
    async destroy() { this.destroyed = true; }
    async resize() { this.resized = true; }
    async manualRender(frame) { this.lastFrame = frame; }
  }
  const context = vm.createContext({
    console, document, window, URL, URLSearchParams, Blob, Uint8Array, DataView, performance,
    Event: class { constructor(type) { this.type = type; } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    WebSocket: WebSocketDouble, location: { protocol: "http:", host: "localhost:3000", search: "", href: undefined },
    crypto: { randomUUID: () => require("node:crypto").randomUUID() },
    localStorage: {
      getItem: (key) => {
        if (storageFailure === "read") throw new Error("Storage read blocked");
        return storage.get(key);
      },
      setItem: (key, value) => {
        if (storageFailure === "write") throw new Error("Storage write blocked");
        storage.set(key, value);
      }
    },
    requestAnimationFrame: (fn) => { const id = nextId++; frames.set(id, fn); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
    queueMicrotask,
    setTimeout: (fn, delay) => { const id = nextId++; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, delay) => { const id = nextId++; timers.set(id, { fn, delay, interval: true }); return id; },
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({}),
      text: async () => "[Script Info]\n[Events]\n", arrayBuffer: async () => new ArrayBuffer(1) }; }
  });
  if (storageFailure === "access") {
    Object.defineProperty(context, "localStorage", { get() { throw new Error("Storage access blocked"); } });
  }
  const modules = new Map();
  function getModule(filename) {
    if (modules.has(filename)) return modules.get(filename);
    let module;
    if (filename === path.join(root, "vendor/movi-player.js")) module = new vm.SyntheticModule(["MoviPlayer"], function () {
      this.setExport("MoviPlayer", { assessPlayback });
    }, { context, identifier: filename });
    else if (filename === path.join(root, "vendor/jassub/jassub.js")) {
      module = new vm.SyntheticModule(["default"], function () { this.setExport("default", SubtitleRendererDouble); }, { context, identifier: filename });
    } else module = new vm.SourceTextModule(fs.readFileSync(filename, "utf8"), { context, identifier: filename });
    modules.set(filename, module); return module;
  }
  async function load(relative) {
    const module = getModule(path.join(root, relative));
    await module.link((specifier, referring) => getModule(path.resolve(path.dirname(referring.identifier), specifier)));
    await module.evaluate();
    if (relative === "js/app.js" && autoContinuePublic) elements.get("continuePublicRoom").dispatch("click");
    return module.namespace;
  }
  function runTimers(delay) {
    for (const [id, timer] of [...timers]) if (timer.delay === delay) {
      if (!timer.interval) timers.delete(id); timer.fn();
    }
  }
  function runFrame(now = 1000) {
    const pending = [...frames]; frames.clear(); pending.forEach(([, fn]) => fn(now));
  }
  return { load, elements, sockets, renderers, requests, storage, document, window, runTimers, runFrame, context, timers };
}

const captionItems = video => [...video.shadowRoot.querySelector('.movi-subtitle-track-list').children].filter(row => row.dataset.roomCaptionKey);
const selectedCaption = video => captionItems(video).find(row => row.getAttribute('aria-checked') === 'true')?.dataset.roomCaptionId || 'off';
const pickCaption = (video, id) => captionItems(video).find(row => id === 'off' ? row.dataset.roomCaptionKey === 'off' : row.dataset.roomCaptionId === id).click();
module.exports = { createBrowserDouble, captionItems, selectedCaption, pickCaption };
