const { execFile } = require("child_process");
const path = require("node:path");

function parseMediaInfo(output, fileName = "") {
  const videoLine = output.split(/\r?\n/).find((line) => /Stream #0:.*Video:/.test(line)) || "";
  const audioLine = output.split(/\r?\n/).find((line) => /Stream #0:.*Audio:/.test(line)) || "";
  const dimensions = /\b(\d{2,5})x(\d{2,5})\b/.exec(videoLine);
  const layout = /\b(\d+)\.(\d+)\b/.exec(audioLine);
  const channels = /\bmono\b/.test(audioLine) ? 1 : /\bstereo\b/.test(audioLine) ? 2 :
    Number(/(\d+) channels/.exec(audioLine)?.[1]) || (layout ? Number(layout[1]) + Number(layout[2]) : 2);
  const extension = path.extname(fileName).toLowerCase();
  const mime = ({ ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".3gp": "video/3gpp", ".3g2": "video/3gpp2", ".webm": "video/webm",
    ".ogv": "video/ogg", ".ogg": "video/ogg", ".ogm": "video/ogg",
    ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".ts": "video/mp2t" })[extension] || "application/octet-stream";
  return { mime, bitrate: Number(/bitrate:\s*(\d+) kb\/s/.exec(output)?.[1]) * 1000 || 0, videoCodec: /Video:\s*(\w+)/.exec(videoLine)?.[1] || "",
    audioCodec: /Audio:\s*(\w+)/.exec(audioLine)?.[1] || "", hasAudio: Boolean(audioLine),
    sampleRate: Number(/(\d+) Hz/.exec(audioLine)?.[1]) || 48000,
    channels,
    pixelFormat: /Video:.*?,\s*((?:yuv|yuva|gbr|rgb|nv12|p010)[a-zA-Z0-9]*)/.exec(videoLine)?.[1] || "",
    width: Number(dimensions?.[1]) || 0, height: Number(dimensions?.[2]) || 0,
    fps: Number(/([\d.]+) fps/.exec(videoLine)?.[1]) || 0,
    bitDepth: /(?:10le|12le|p010|p012)/.test(videoLine) ? 10 : 8,
    hdr: /smpte2084|arib-std-b67/.test(videoLine) };
}

function parseDuration(stderr) {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
}

function parseSubtitleStreams(output, sourcePath) {
  const subtitles = [];
  // Stream metadata follows its header, up to the next stream. Do not let a
  // video/audio title (or the container title) become a subtitle's name.
  for (const block of output.split(/(?=^[ \t]*Stream #)/m)) {
    const line = block.split(/\r?\n/, 1)[0];
    const match = /Stream #0:(\d+)(?:\[[^\]]+\])?(?:\(([^)]+)\))?: Subtitle:/.exec(line);
    if (!match || subtitles.length >= 8) continue;
    const codec = (/Subtitle:\s*([a-zA-Z0-9_]+)/.exec(line)?.[1] || "").toLowerCase();
    if (!["ass", "ssa", "subrip", "srt", "webvtt", "mov_text", "text"].includes(codec)) continue;
    const title = /^\s+title\s*:\s*(.+)$/im.exec(block)?.[1].trim() ||
      /^\s+handler_name\s*:\s*(.+)$/im.exec(block)?.[1].trim();
    const identifier = /Stream #0:\d+\[([^\]]+)\]/.exec(line)?.[1];
    subtitles.push({ input: sourcePath, map: `0:${match[1]}`, ...(identifier && /^(?:0x[\da-f]+|\d+)$/i.test(identifier) ? { streamId: Number(identifier) } : {}), codec, lang: match[2] || "und",
      title, label: title || `Captions ${subtitles.length + 1}`,
      default: /\(default\)/i.test(line), forced: /\(forced\)/i.test(line) });
  }
  return subtitles;
}

function probeMedia(sourcePath, ffmpegPath, signal, fileName) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ["-hide_banner", ...(sourcePath.startsWith("http:") ? ["-rw_timeout", "30000000"] : []), "-i", sourcePath], { windowsHide: true, maxBuffer: 4 * 1024 * 1024, signal }, (error, _stdout, stderr) => {
      const output = String(stderr || "");
      const duration = parseDuration(output);
      if (!duration) { reject(new Error(error?.message || "Could not determine the video duration.")); return; }
      const subtitles = parseSubtitleStreams(output, sourcePath);
      const fonts = [];
      for (const line of output.split(/\r?\n/)) {
        const attachment = /Stream #0:(\d+).*Attachment:\s*(ttf|otf)/.exec(line);
        if (attachment && fonts.length < 16) fonts.push({ map: attachment[1], extension: attachment[2] });
      }
      resolve({ duration, subtitles, fonts, info: parseMediaInfo(output, fileName) });
    });
  });
}

module.exports = { parseDuration, parseMediaInfo, parseSubtitleStreams, probeMedia };
