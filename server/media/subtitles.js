const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function createSubtitleService({ state, config }) {
  const captions = new Map();
  const processes = new Set();
  let fonts = [], fontJob, fontVersion;

  function run(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(config.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...args], { windowsHide: true, stdio: "ignore" });
      processes.add(child);
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Caption or font extraction failed.")));
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
      const directory = state.hlsDirectory, source = state.mediaPath, version = fontVersion;
      fontJob = run([
        ...fonts.flatMap((font) => [`-dump_attachment:${font.map}`, path.join(directory, font.fileName)]),
        ...(source.startsWith("http:") ? ["-rw_timeout", "30000000"] : []), "-i", source,
        "-map", "0:v:0", "-frames:v", "0", "-f", "null", "-"
      ]).then(() => { if (version !== state.mediaVersion) throw new Error("Source replaced."); });
    }
    return fontJob;
  }

  function register(subtitle, version) {
    if (!captions.has(subtitle.fileName)) captions.set(subtitle.fileName, { subtitle, version, directory: state.hlsDirectory, promise: null });
    return { id: subtitle.id, fileId: subtitle.fileId,
      url: `${state.basePath || ""}/hls/${subtitle.fileName}?v=${version}`,
      label: subtitle.label, lang: subtitle.lang || "und", format: "ass", originalFormat: subtitle.codec || "unknown",
      fonts: fontFiles().map((file) => `${state.basePath || ""}/hls/${file}?v=${version}`) };
  }

  async function wait(fileName) {
    const job = captions.get(fileName);
    if (!job || job.version !== state.mediaVersion) throw new Error("Caption is no longer available.");
    if (!job.promise) {
      const { subtitle, directory, version } = job;
      const output = path.join(directory, subtitle.fileName);
      job.promise = (async () => {
        const args = [...(subtitle.input.startsWith("http:") ? ["-rw_timeout", "30000000"] : []), "-i", subtitle.input];
        if (subtitle.map) args.push("-map", subtitle.map);
        args.push("-c:s", ["ass", "ssa"].includes(subtitle.codec) ? "copy" : "ass", output);
        await run(args);
        if (version !== state.mediaVersion || captions.get(fileName) !== job) throw new Error("Caption extraction was replaced.");
        await waitForFonts().catch(() => {});
      })();
    }
    return job.promise;
  }

  async function extract(subtitle, version) {
    const track = register(subtitle, version);
    try { await wait(subtitle.fileName); return track; } catch { return null; }
  }

  function stop() {
    for (const child of processes) child.kill();
    captions.clear(); fonts = []; fontJob = null;
  }

  function remove(fileName) {
    captions.delete(fileName);
    if (state.hlsDirectory) fs.rm(path.join(state.hlsDirectory, fileName), { force: true }, () => {});
  }

  return { register, extract, stop, wait, remove, setFonts, waitForFonts, fontFiles };
}

module.exports = { createSubtitleService };
