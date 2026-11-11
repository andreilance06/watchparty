const { execFile } = require("node:child_process");
const { currentTime } = require("../state");
const { createPreparationBudget } = require("./preparation-budget");

// All rooms share one worker. A room can have only one queued or running job.
function createThumbnailQueue() {
  const pending = new Map();
  let running = null;
  async function pump() {
    if (running || !pending.size) return;
    const [key, job] = pending.entries().next().value;
    pending.delete(key);
    running = { key, ...job };
    try { await job.work(job.controller.signal); } catch {} // Previews never fail playback.
    finally { running = null; void pump(); }
  }
  return {
    enqueue(key, work) {
      if (pending.has(key) || running?.key === key) return;
      pending.set(key, { work, controller: new AbortController() });
      queueMicrotask(pump);
    },
    cancel(key) {
      pending.get(key)?.controller.abort();
      pending.delete(key);
      if (running?.key === key) running.controller.abort();
    }
  };
}

function extractThumbnail({ config, sourcePath, inputArgs, time, signal }) {
  return new Promise((resolve, reject) => {
    execFile(config.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-filter_threads", "1", "-filter_complex_threads", "1", "-threads", "1",
      ...inputArgs, "-ss", String(time), "-i", sourcePath, "-map", "0:v:0", "-an", "-sn", "-dn",
      "-vf", "scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2,setsar=1",
      "-frames:v", "1", "-threads", "1", "-c:v", "mjpeg", "-q:v", "5", "-f", "image2pipe", "pipe:1"],
    { windowsHide: true, encoding: "buffer", maxBuffer: 256 * 1024, signal }, (error, stdout) => {
      if (error) { reject(error); return; }
      if (stdout.length < 4 || stdout[0] !== 0xff || stdout[1] !== 0xd8) { reject(new Error("No video frame available.")); return; }
      resolve(stdout);
    });
  });
}

function createThumbnails({ state, config, queue, capture = extractThumbnail, now = Date.now }) {
  // A fresh key after cancellation allows replacement sources to queue while the old process exits.
  let key = Symbol("thumbnail"), image = null, lastAttempt = -Infinity, lastPosition = null, revision = 0;
  function reset() {
    queue.cancel(key); key = Symbol("thumbnail");
    image = null; lastAttempt = -Infinity; lastPosition = null;
  }
  function refresh() {
    if (!state.mediaReady || !state.mediaPath || now() - lastAttempt < 30000) return;
    const position = Math.max(0, Math.min(currentTime(state), Math.max(0, state.mediaDuration - 0.1)));
    if (state.playback.paused && image && Math.abs(position - lastPosition) < 0.05) return;
    lastAttempt = now();
    const version = state.mediaVersion, jobKey = key;
    queue.enqueue(jobKey, async signal => {
      if (version !== state.mediaVersion || signal.aborted || !state.mediaReady) return;
      const budget = createPreparationBudget({ mediaPreparationBytes: 16 * 1024 * 1024, mediaPreparationMs: 10000 }, signal);
      let lease;
      try {
        lease = state.openMediaLease?.(budget);
        const time = Math.max(0, Math.min(currentTime(state), Math.max(0, state.mediaDuration - 0.1)));
        const data = await capture({ config, sourcePath: lease?.url || state.mediaPath,
          inputArgs: state.mediaInputArgs || [], time, signal: budget.signal });
        if (data.length > 256 * 1024 || budget.signal.aborted || version !== state.mediaVersion || key !== jobKey) return;
        image = { data, version, revision: ++revision };
        lastPosition = time;
      } finally { lease?.close(); budget.cancel(); }
    });
  }
  return { reset, refresh, get: () => image && image.version === state.mediaVersion && state.mediaReady ? image : null };
}

module.exports = { createThumbnailQueue, createThumbnails, extractThumbnail };
