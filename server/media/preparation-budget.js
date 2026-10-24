const LIMIT_MESSAGE = "Video preparation exceeded its read or time limit. Remux this file to a seekable MP4 or MKV and select it again.";

function createPreparationBudget(config = {}, parentSignal) {
  const controller = new AbortController();
  const maxBytes = config.mediaPreparationBytes ?? 32 * 1024 * 1024;
  const metrics = { bytes: 0, reads: 0 };
  let active = true, error;
  const abort = () => controller.abort(parentSignal.reason);
  parentSignal?.addEventListener("abort", abort, { once: true });
  if (parentSignal?.aborted) abort();
  function limit() {
    error ||= Object.assign(new Error(LIMIT_MESSAGE), { code: "MEDIA_PREPARATION_LIMIT" });
    controller.abort(error);
    return error;
  }
  const timer = setTimeout(limit, config.mediaPreparationMs ?? 30000);
  timer.unref?.();
  return {
    signal: controller.signal, metrics,
    get error() { return error; },
    consume(bytes) {
      controller.signal.throwIfAborted();
      if (active && metrics.bytes + bytes > maxBytes) throw limit();
      metrics.bytes += bytes; metrics.reads++;
    },
    // A continuous encoder can keep its lease after publishing the first segment.
    finish() { active = false; clearTimeout(timer); parentSignal?.removeEventListener("abort", abort); },
    cancel() { this.finish(); controller.abort(); }
  };
}

module.exports = { createPreparationBudget, LIMIT_MESSAGE };
