const path = require("path");

function resolveFfmpegPath() {
  let ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
  try { ffmpegPath = require("ffmpeg-static") || ffmpegPath; } catch {}
  return ffmpegPath;
}

function createConfig(overrides = {}) {
  return {
    port: Number(process.env.PORT) || 3000,
    publicDirectory: path.resolve(__dirname, ".."),
    segmentSeconds: 4,
    maxSegmentsAhead: 2,
    ffmpegPath: resolveFfmpegPath(),
    ...overrides
  };
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".wasm": "application/wasm",
  ".woff2": "font/woff2", ".ass": "text/plain; charset=utf-8", ".ssa": "text/plain; charset=utf-8",
  ".m3u8": "application/vnd.apple.mpegurl", ".vtt": "text/vtt; charset=utf-8",
  ".ts": "video/mp2t"
};

module.exports = { createConfig, MIME_TYPES };
