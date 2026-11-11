const path = require("path");
const { createEncoderBudget } = require("./media/encoder-budget");

function resolveFfmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  let ffmpegPath = "ffmpeg";
  try { ffmpegPath = require("ffmpeg-static") || ffmpegPath; } catch {}
  return ffmpegPath;
}

function createConfig(overrides = {}) {
  const memoryLimit = process.constrainedMemory?.() || 0;
  const lowMemory = overrides.lowMemory ?? (process.env.WATCHPARTY_LOW_MEMORY === undefined
    ? memoryLimit > 0 && memoryLimit <= 768 * 1024 * 1024 : process.env.WATCHPARTY_LOW_MEMORY === "1");
  const config = {
    lowMemory,
    ffmpegThreads: process.env.WATCHPARTY_FFMPEG_THREADS === undefined ? (lowMemory ? 1 : 0) : Number(process.env.WATCHPARTY_FFMPEG_THREADS),
    port: Number(process.env.PORT) || 3000,
    host: process.env.HOST || "0.0.0.0",
    publicDirectory: path.resolve(__dirname, "../dist"),
    segmentSeconds: 2,
    maxSegmentsAhead: lowMemory ? 1 : 2,
    maxEncoders: process.env.WATCHPARTY_MAX_ENCODERS === undefined ? (lowMemory ? 1 : 2) : Number(process.env.WATCHPARTY_MAX_ENCODERS),
    renditionIdleMs: lowMemory ? 2000 : 10000,
    renditionCacheBytes: 128 * 1024 * 1024,
    roomIdleMs: 30 * 60 * 1000,
    hostReconnectGraceMs: 15000,
    sourceReadTimeoutMs: 30000,
    sourceChunkBytes: 256 * 1024,
    sourceMaxReads: lowMemory ? 2 : 4,
    sourceCacheBytes: (lowMemory ? 4 : 16) * 1024 * 1024,
    mediaPreparationBytes: 32 * 1024 * 1024,
    mediaPreparationMs: 30000,
    trustProxy: process.env.TRUST_PROXY === "loopback" ? "loopback" : false,
    publicOrigin: process.env.PUBLIC_ORIGIN || "",
    ffmpegPath: resolveFfmpegPath(),
    ffprobePath: null,
    ...overrides
  };
  if (process.env.WATCHPARTY_LOW_MEMORY !== undefined && !["0", "1"].includes(process.env.WATCHPARTY_LOW_MEMORY)) throw new Error("WATCHPARTY_LOW_MEMORY must be 0 or 1.");
  if (!Number.isInteger(config.ffmpegThreads) || config.ffmpegThreads < 0 || config.ffmpegThreads > 64) throw new Error("ffmpegThreads must be an integer between 0 and 64.");
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
