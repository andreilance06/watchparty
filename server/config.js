const path = require("path");
const { createEncoderBudget } = require("./media/encoder-budget");

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
    maxEncoders: process.env.WATCHPARTY_MAX_ENCODERS === undefined ? 2 : Number(process.env.WATCHPARTY_MAX_ENCODERS),
    renditionIdleMs: 10000,
    renditionCacheBytes: 128 * 1024 * 1024,
    roomIdleMs: 30 * 60 * 1000,
    hostReconnectGraceMs: 15000,
    sourceReadTimeoutMs: 30000,
    sourceChunkBytes: 256 * 1024,
    sourceMaxReads: 4,
    sourceCacheBytes: 16 * 1024 * 1024,
    trustProxy: process.env.TRUST_PROXY === "loopback" ? "loopback" : false,
    publicOrigin: process.env.PUBLIC_ORIGIN || "",
    ffmpegPath: resolveFfmpegPath(),
    ...overrides
  };
  if (!Number.isInteger(config.maxEncoders) || config.maxEncoders < 1) throw new Error("maxEncoders must be a positive integer.");
  config.encoderBudget ||= createEncoderBudget(config.maxEncoders);
  if (!Number.isFinite(config.hostReconnectGraceMs) || config.hostReconnectGraceMs < 0) throw new Error("hostReconnectGraceMs must be a non-negative number.");
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
