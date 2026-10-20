import JASSUB from "../../vendor/jassub/jassub.js";

// Movi's public SubtitleRenderer contract, backed by complete normalized ASS
// tracks. Embedded packet decoding stays disabled so seeks never lose signs or
// dialogue which started before the requested timestamp.
export function createJassubAdapter({ video, report, loadContent, onState = () => {}, isPictureReady = () => true }) {
  let container, canvas, renderer, pendingRenderer, generation = 0, delay = 0, frame = 0;
  let selected = null, destroyed = false, signature = "", lastHook = -Infinity;
  let status = "off";
  const fonts = new Map();
  const surface = document.createElement("div");
  Object.assign(surface.style, { position: "relative", width: "100%", height: "100%", pointerEvents: "none" });
  const observer = globalThis.ResizeObserver ? new ResizeObserver(() => refresh()) : null;

  function mount(target) {
    if (destroyed) return;
    container = target;
    if (target !== surface) target.appendChild(surface);
    observer?.observe(target);
    refresh();
  }
  function layout() {
    if (!canvas || !container) return;
    const width = container.clientWidth || video.clientWidth || 16;
    const height = container.clientHeight || video.clientHeight || 9;
    const picture = video.player?.getHLSVideoElement?.() || video.player?.getVideoElement?.() || video;
    const ratio = (picture.videoWidth || width) / (picture.videoHeight || height);
    const pictureWidth = Math.min(width, height * ratio), pictureHeight = Math.min(height, width / ratio);
    Object.assign(canvas.style, { width: `${pictureWidth}px`, height: `${pictureHeight}px`,
      left: `${(width - pictureWidth) / 2}px`, top: `${(height - pictureHeight) / 2}px` });
  }
  async function render(mediaTime, width, height) {
    if (!renderer || renderer.busy || destroyed || document.hidden || !isPictureReady()) return;
    const picture = video.player?.getHLSVideoElement?.() || video.player?.getVideoElement?.() || video;
    width ||= picture.videoWidth; height ||= picture.videoHeight;
    const fps = window.innerWidth < 900 ? 20 : 30;
    const key = `${width}x${height}@${Math.floor((mediaTime - delay) * fps)}`;
    if (key === signature) return;
    signature = key;
    try {
      await renderer.manualRender({ expectedDisplayTime: performance.now(), width: width || 16, height: height || 9,
        mediaTime: Math.max(0, mediaTime - delay) }, Boolean(video.paused));
    } catch { signature = ""; }
  }
  function bridge() {
    frame = 0;
    if (destroyed || !selected) return;
    // Native/HLS engines do not drive Movi's embedded-subtitle renderer hook.
    // Only this adapter supplies their clock; do not duplicate the WASM hook.
    if (performance.now() - lastHook > 100) render(Number(video.currentTime) || 0, video.videoWidth, video.videoHeight);
    frame = requestAnimationFrame(bridge);
  }
  function refresh() { signature = ""; layout(); renderer?.resize(true).catch(() => {}); }
  function loadFont(url) {
    if (!fonts.has(url)) fonts.set(url, fetch(url).then(async (response) => {
      if (!response.ok) throw new Error("Font is unavailable.");
      return new Uint8Array(await response.arrayBuffer());
    }).catch((error) => { fonts.delete(url); throw error; }));
    return fonts.get(url);
  }
  async function select(track) {
    if (destroyed) return;
    if (track && selected?.id === track.id && selected?.url === track.url && status !== "error") return;
    selected = track;
    const token = ++generation;
    status = track ? "preparing" : "off";
    onState(status, track ? "loading-assets" : null);
    const previous = renderer || pendingRenderer;
    renderer = null; pendingRenderer = null;
    cancelAnimationFrame(frame); frame = 0;
    canvas?.remove(); canvas = null;
    if (previous) await previous.destroy().catch(() => {});
    if (!track || destroyed || token !== generation) return;
    try {
      const [content, fontResults] = await Promise.all([
        loadContent(track.url),
        Promise.allSettled(["/vendor/jassub/default.woff2", ...(track.fonts || [])].map(loadFont))
      ]);
      if (destroyed || token !== generation) return;
      onState(status, "starting-renderer");
      canvas = document.createElement("canvas");
      Object.assign(canvas.style, { position: "absolute", pointerEvents: "none", background: "transparent" });
      surface.appendChild(canvas); layout();
      const next = new JASSUB({ canvas, subContent: content,
        fonts: fontResults.filter((result) => result.status === "fulfilled").map((result) => result.value), queryFonts: false,
        workerUrl: "/vendor/jassub/worker.js", wasmUrl: "/vendor/jassub/jassub-worker.wasm",
        modernWasmUrl: "/vendor/jassub/jassub-worker-modern.wasm", prescaleHeightLimit: 1080 });
      pendingRenderer = next;
      await next.ready;
      if (destroyed || token !== generation) { await next.destroy(); return; }
      pendingRenderer = null; renderer = next;
      signature = ""; refresh();
      status = "ready"; onState(status);
      frame = requestAnimationFrame(bridge);
    } catch (error) {
      if (token === generation && !destroyed) {
        const failed = pendingRenderer;
        pendingRenderer = null;
        canvas?.remove(); canvas = null;
        if (failed) await failed.destroy().catch(() => {});
        if (token !== generation || destroyed) return;
        status = "error";
        onState(status);
        report(`Could not load captions: ${error.message || error}`);
      }
    }
  }
  const adapter = {
    mount, configure() {}, pushPacket() {},
    render(time, width, height) {
      lastHook = performance.now();
      // The element exposes a zero-based clock across source timestamp offsets.
      return render(Number(video.currentTime) || 0, width, height);
    },
    setDelay(value) { delay = value; signature = ""; },
    clear() { signature = ""; },
    async destroy() {
      if (destroyed) return;
      destroyed = true; generation++; selected = null;
      fonts.clear();
      cancelAnimationFrame(frame); observer?.disconnect();
      const previous = renderer || pendingRenderer; renderer = null; pendingRenderer = null;
      if (previous) await previous.destroy().catch(() => {});
      surface.remove();
    },
    select, refresh, surface, get destroyed() { return destroyed; }
  };
  return adapter;
}
