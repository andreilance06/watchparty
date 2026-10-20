const path = require("path");

function resolveFfmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  let ffmpegPath = "ffmpeg";
  try { ffmpegPath = require("ffmpeg-static") || ffmpegPath; } catch {}
  return ffmpegPath;
}

function createConfig(overrides = {}) {
  const config = {
    port: Number(process.env.PORT) || 3000,
    host: process.env.HOST || "0.0.0.0",
    publicDirectory: path.resolve(__dirname, ".."),
    segmentSeconds: 2,
    maxSegmentsAhead: 2,
    roomIdleMs: 30 * 60 * 1000,
    sourceReadTimeoutMs: 30000,
    sourceChunkBytes: 256 * 1024,
    sourceMaxReads: 4,
    sourceCacheBytes: 16 * 1024 * 1024,
    trustProxy: process.env.TRUST_PROXY === "loopback" ? "loopback" : false,
    publicOrigin: process.env.PUBLIC_ORIGIN || "",
    ffmpegPath: resolveFfmpegPath(),
    ...overrides
  };
  if (config.publicOrigin) {
    const origin = new URL(config.publicOrigin);
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) throw new Error("PUBLIC_ORIGIN must be an HTTP(S) origin.");
    config.publicOrigin = origin.origin;
  }
  return config;
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".wasm": "application/wasm",
  ".woff2": "font/woff2", ".ass": "text/plain; charset=utf-8", ".ssa": "text/plain; charset=utf-8",
  ".m3u8": "application/vnd.apple.mpegurl", ".vtt": "text/vtt; charset=utf-8",
  ".ts": "video/mp2t", ".ttf": "font/ttf", ".otf": "font/otf", ".png": "image/png"
};

module.exports = { createConfig, MIME_TYPES };
