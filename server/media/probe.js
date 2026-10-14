const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

function parseDuration(stderr) {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
}

function probeMedia(sourcePath, ffmpegPath) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ["-hide_banner", "-i", sourcePath], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      const output = String(stderr || "");
      const duration = parseDuration(output);
      if (!duration) { reject(new Error(error?.message || "Could not determine the video duration.")); return; }
      const subtitles = [];
      for (const line of output.split(/\r?\n/)) {
        const match = /Stream #0:(\d+)(?:\[[^\]]+\])?(?:\(([^)]+)\))?: Subtitle:/.exec(line);
        if (!match || subtitles.length >= 8) continue;
        const codec = (/Subtitle:\s*([a-zA-Z0-9_]+)/.exec(line)?.[1] || "").toLowerCase();
        subtitles.push({ input: sourcePath, map: `0:${match[1]}`, codec, lang: match[2] || "und", label: `Embedded ${subtitles.length + 1}${match[2] ? ` (${match[2]})` : ""}` });
      }
      resolve({ duration, subtitles });
    });
  });
}

function findSidecarSubtitles(sourcePath) {
  const directory = path.dirname(sourcePath);
  const stem = path.basename(sourcePath, path.extname(sourcePath)).toLowerCase();
  const supported = new Set([".srt", ".vtt", ".ass", ".ssa"]);
  try {
    return fs.readdirSync(directory)
      .filter((name) => name.toLowerCase().startsWith(`${stem}.`) && supported.has(path.extname(name).toLowerCase()))
      .slice(0, 8)
      .map((name) => ({ input: path.join(directory, name), map: null, codec: path.extname(name).slice(1).toLowerCase(), label: path.basename(name, path.extname(name)), lang: "und" }));
  } catch { return []; }
}

module.exports = { parseDuration, probeMedia, findSidecarSubtitles };
