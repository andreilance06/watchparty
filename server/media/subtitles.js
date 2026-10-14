const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function createSubtitleService({ state, config }) {
  const FFMPEG_PATH = config.ffmpegPath;
  const captionJobs = new Map();

  function extractCaption(subtitle, version) {
    const outputPath = path.join(state.hlsDirectory, subtitle.fileName);
    const job = { process: null, promise: null };
    job.promise = new Promise((resolve, reject) => {
      if (!subtitle.map && (subtitle.codec === "ass" || subtitle.codec === "ssa")) {
        fs.copyFile(subtitle.input, outputPath, (error) => error ? reject(error) : resolve(outputPath));
        return;
      }
      const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", subtitle.input];
      if (subtitle.map) args.push("-map", subtitle.map);
      args.push("-c:s", subtitle.codec === "ass" || subtitle.codec === "ssa" ? "copy" : "ass", outputPath);
      job.process = spawn(FFMPEG_PATH, args, { windowsHide: true });
      job.process.once("error", reject);
      job.process.once("exit", (code) => {
        if (version !== state.mediaVersion) { reject(new Error("Caption extraction was replaced.")); return; }
        if (code === 0) resolve(outputPath); else reject(new Error("Caption conversion failed."));
      });
    }).catch((error) => { job.error = error; return null; });
    captionJobs.set(subtitle.fileName, job);
    return job.promise.then((result) => result ? {
      url: `/hls/${subtitle.fileName}?v=${version}`,
      label: subtitle.label,
      lang: subtitle.lang || "und",
      format: "ass",
      originalFormat: subtitle.codec || "unknown"
    } : null);
  }

  function stop() {
    for (const job of captionJobs.values()) {
      if (job.process && job.process.exitCode === null) job.process.kill();
    }
    captionJobs.clear();
  }

  async function wait(fileName) {
    const job = captionJobs.get(fileName);
    if (job) await job.promise;
  }

  return { extract: extractCaption, stop, wait };
}

module.exports = { createSubtitleService };
