const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createCaptionSource } = require("./caption-source");
const { unsupported } = require("./containers/bytes");

function createSubtitleService({ state, config }) {
  const captions = new Map();
  const processes = new Set();
  let fonts = [], fontJob, fontVersion;
  let source, controller;

  function setSource(reader) {
    controller?.abort();
    controller = new AbortController();
    source = reader ? createCaptionSource(reader, controller.signal) : null;
  }

  async function discover() {
    if (!source) return [];
    const catalog = await source.discover();
    return catalog.tracks.slice(0, 8).map((track, index) => ({
      input: state.mediaPath, map: `0:${track.streamIndex}`, streamId: track.trackId,
      codec: track.codec, title: track.title, label: track.title || `Captions ${index + 1}`,
      lang: track.lang || "und", default: Boolean(track.default), forced: Boolean(track.forced)
    }));
  }

  function run(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(config.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...args], { windowsHide: true, stdio: "ignore" });
      processes.add(child);
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Caption conversion failed. Add an external SRT, VTT, ASS, or SSA subtitle file.")));
      child.once("close", () => processes.delete(child));
    });
  }

  const fontFiles = () => fonts.map((font) => font.fileName);
  function setFonts(entries, version) {
    fonts = entries.map((font, index) => ({ ...font, fileName: `font_${index}.${font.extension}` }));
    fontVersion = version; fontJob = null;
  }

  function waitForFonts() {
    if (!fonts.length) return Promise.resolve();
    if (!fontJob) {
      const directory = state.hlsDirectory, version = fontVersion, selectedSource = source;
      fontJob = (async () => {
        if (!selectedSource) throw unsupported();
        for (const font of fonts) await selectedSource.font(font, path.join(directory, font.fileName));
        if (version !== state.mediaVersion) throw new Error("Source replaced.");
      })();
    }
    return fontJob;
  }

  function register(subtitle, version) {
    if (!captions.has(subtitle.fileName)) captions.set(subtitle.fileName, { subtitle, version, directory: state.hlsDirectory, promise: null });
    return { id: subtitle.id, fileId: subtitle.fileId,
      url: `${state.basePath || ""}/hls/${subtitle.fileName}?v=${version}`,
      label: subtitle.label, title: subtitle.title, lang: subtitle.lang || "und",
      default: Boolean(subtitle.default), forced: Boolean(subtitle.forced),
      format: "ass", originalFormat: subtitle.codec || "unknown",
      fonts: fontFiles().map((file) => `${state.basePath || ""}/hls/${file}?v=${version}`) };
  }

  async function wait(fileName) {
    const job = captions.get(fileName);
    if (!job || job.version !== state.mediaVersion) throw new Error("Caption is no longer available.");
    if (!job.promise) {
      const { subtitle, directory, version } = job;
      const output = path.join(directory, subtitle.fileName);
      const selectedSource = source, signal = controller?.signal;
      job.promise = (async () => {
        const started = performance.now();
        let input = subtitle.input, temporary;
        try {
          if (subtitle.map) {
            if (!selectedSource) throw unsupported();
            const extracted = await selectedSource.extract(subtitle, output);
            temporary = input = extracted.filePath;
            job.metrics = extracted.metrics;
          }
          signal?.throwIfAborted();
          if (version !== state.mediaVersion || captions.get(fileName) !== job) throw new Error("Caption extraction was replaced.");
          const args = [...(temporary ? ["-protocol_whitelist", "file,pipe"] : input.startsWith("http:") ? ["-rw_timeout", "30000000"] : []), "-i", input,
            "-map", "0:s:0", "-c:s", ["ass", "ssa"].includes(subtitle.codec) ? "copy" : "ass", output];
          const conversion = performance.now();
          await run(args);
          job.metrics = { ...(job.metrics || { indexMode: "external" }), conversionMs: performance.now() - conversion };
          if (version !== state.mediaVersion || captions.get(fileName) !== job) throw new Error("Caption extraction was replaced.");
          await waitForFonts().catch(() => {});
          job.metrics.totalMs = performance.now() - started;
        } finally {
          if (temporary) await fs.promises.rm(temporary, { force: true }).catch(() => {});
        }
      })();
    }
    return job.promise;
  }

  async function extract(subtitle, version) {
    const track = register(subtitle, version);
    try { await wait(subtitle.fileName); return track; } catch { return null; }
  }

  function stop() {
    controller?.abort(); source = null;
    for (const child of processes) child.kill();
    captions.clear(); fonts = []; fontJob = null;
  }

  function remove(fileName) {
    captions.delete(fileName);
    if (state.hlsDirectory) fs.rm(path.join(state.hlsDirectory, fileName), { force: true }, () => {});
  }

  const metrics = fileName => captions.get(fileName)?.metrics;

  return { register, extract, stop, wait, remove, setSource, discover, setFonts, waitForFonts, fontFiles, metrics };
}

module.exports = { createSubtitleService };
