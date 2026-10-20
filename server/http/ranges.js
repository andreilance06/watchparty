const { once } = require("node:events");

function parseRange(value, size) {
  if (!value) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return null;
  return { start, end, partial: true };
}

// The producer is bounded independently of HTTP request size. Pipeline a few
// reads to avoid one network round trip per chunk, and stop them on disconnect.
async function serveByteSource(req, res, { size, type, read, chunkBytes, concurrency = 4 }) {
  const range = parseRange(req.headers.range, size);
  if (!range) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); res.end(); return; }
  const { start, end, partial } = range;
  res.writeHead(partial ? 206 : 200, {
    "Content-Type": type || "application/octet-stream", "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1, "Cache-Control": "no-store",
    ...(partial ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {})
  });
  if (req.method === "HEAD") { res.end(); return; }
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once("close", abort);
  const pending = [];
  let offset = start;
  const fill = () => {
    while (offset <= end && pending.length < concurrency && !controller.signal.aborted) {
      const at = offset;
      const length = Math.min(chunkBytes - at % chunkBytes, end - at + 1);
      // Store failures as values immediately so speculative reads never produce
      // unhandled rejections while a preceding chunk is backpressured.
      pending.push(Promise.resolve().then(() => read(at, length, controller.signal))
        .then((bytes) => ({ bytes }), (error) => ({ error })));
      offset += length;
    }
  };
  try {
    fill();
    while (pending.length && !controller.signal.aborted) {
      const { bytes, error } = await pending.shift();
      if (error) throw error;
      if (controller.signal.aborted) break;
      if (!res.write(bytes)) await once(res, "drain", { signal: controller.signal });
      fill();
    }
    if (!controller.signal.aborted) res.end();
  } catch { res.destroy(); }
  finally { res.removeListener("close", abort); controller.abort(); }
}

module.exports = { parseRange, serveByteSource };
