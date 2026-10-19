const { execFile } = require("child_process");

function parseDuration(stderr) {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
}

function probeMedia(sourcePath, ffmpegPath, signal) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ["-hide_banner", ...(sourcePath.startsWith("http:") ? ["-rw_timeout", "30000000"] : []), "-i", sourcePath], { windowsHide: true, maxBuffer: 4 * 1024 * 1024, signal }, (error, _stdout, stderr) => {
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

module.exports = { parseDuration, probeMedia };
