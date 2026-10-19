const http = require("node:http");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { sessionState } = require("./state");

// Only FFmpeg sees these capability URLs. The browser supplies bytes, never URLs.
function createSourceBridge(config) {
  const entries = new Map();
  let origin;
  const server = http.createServer(async (req, res) => {
    const [, token, fileId, extra] = req.url.split("?")[0].split("/");
    const entry = !extra && entries.get(token);
    const file = entry?.files.get(fileId);
    if (!file || !["GET", "HEAD"].includes(req.method)) { res.writeHead(404); res.end(); return; }
    let start = 0, end = file.size - 1;
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) { res.writeHead(416, { "Content-Range": `bytes */${file.size}` }); res.end(); return; }
      if (!match[1]) start = Math.max(0, file.size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= file.size) {
        res.writeHead(416, { "Content-Range": `bytes */${file.size}` }); res.end(); return;
      }
    }
    res.writeHead(range ? 206 : 200, {
      "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes", "Content-Length": end - start + 1,
      "Cache-Control": "no-store", ...(range ? { "Content-Range": `bytes ${start}-${end}/${file.size}` } : {})
    });
    if (req.method === "HEAD") { res.end(); return; }
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", abort);
    try {
      for (let offset = start; offset <= end; offset += config.sourceChunkBytes) {
        const length = Math.min(config.sourceChunkBytes, end - offset + 1);
        const bytes = await entry.read(fileId, offset, length, controller.signal);
        if (!res.write(bytes)) await once(res, "drain", { signal: controller.signal });
      }
      res.end();
    } catch { res.destroy(); }
    finally { res.removeListener("close", abort); controller.abort(); }
  });
  return {
    async listen() {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      origin = `http://127.0.0.1:${server.address().port}`;
    },
    register(entry) {
      if (!origin) throw new Error("Source bridge is not listening.");
      const token = crypto.randomBytes(32).toString("base64url");
      entries.set(token, entry);
      return { url: (fileId) => `${origin}/${token}/${fileId}`, close: () => entries.delete(token) };
    },
    async close() {
      entries.clear();
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    }
  };
}

function validateFile(file, caption = false) {
  if (!file || typeof file.id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(file.id) ||
      typeof file.name !== "string" || !file.name || file.name.length > 255 ||
      !Number.isSafeInteger(file.size) || file.size <= 0) throw new Error("Invalid file metadata.");
  const name = file.name.split(/[\\/]/).at(-1);
  if (!name || /[\x00-\x1f]/.test(name)) throw new Error("Invalid filename.");
  const codec = name.split(".").at(-1).toLowerCase();
  if (caption && !["srt", "vtt", "ass", "ssa"].includes(codec)) throw new Error("Choose SRT, VTT, ASS, or SSA captions.");
  return { id: file.id, name, size: file.size, codec, type: typeof file.type === "string" ? file.type.slice(0, 100) : "" };
}

function createHostSource({ room, bridge, config }) {
  let active = null;
  const send = (ws, payload) => room.transport.send(ws, payload);
  const isHost = (ws) => room.state.hostId === ws.clientId && room.state.clients.get(ws.clientId)?.ws === ws;

  function reset() {
    const source = active;
    active = null;
    if (!source) return;
    source.closed = true;
    clearTimeout(source.attachTimer);
    source.bridge?.close();
    for (const job of [...source.pending.values(), ...source.queue]) job.fail(new Error("Source is no longer available."));
    source.ws?.close(1000, "Source replaced");
  }

  function unavailable(source) {
    if (active !== source || source.closed) return;
    reset();
    room.media.reset();
    room.transport.broadcast(sessionState(room.state, "source"));
    room.transport.broadcast({ type: "media-error", message: "The host file connection was lost. Choose the video again." });
  }

  function pump(source) {
    if (source.closed || source.ws?.readyState !== 1) return;
    while (source.pending.size < config.sourceMaxReads && source.queue.length) {
      const job = source.queue.shift();
      if (job.done) continue;
      source.pending.set(job.id, job);
      send(source.ws, { type: "source-read", requestId: job.id, fileId: job.fileId, offset: job.offset, length: job.length });
    }
  }

  function read(source, fileId, offset, length, signal) {
    return new Promise((resolve, reject) => {
      if (source.closed || source.ws?.readyState !== 1 || signal.aborted) { reject(new Error("Source unavailable.")); return; }
      if (source.queue.length >= 64) { reject(new Error("Source is busy.")); return; }
      const id = source.nextRequest++;
      if (id > 0xffffffff) { reject(new Error("Source request limit reached. Reselect the video.")); return; }
      const job = { id, fileId, offset, length, done: false };
      const finish = (error, bytes) => {
        if (job.done) return;
        job.done = true;
        clearTimeout(job.timer);
        signal.removeEventListener("abort", abort);
        source.pending.delete(id);
        const queued = source.queue.indexOf(job);
        if (queued >= 0) source.queue.splice(queued, 1);
        if (error) reject(error); else resolve(bytes);
        pump(source);
      };
      const abort = () => finish(new Error("Read cancelled."));
      job.fail = (error) => finish(error);
      job.succeed = (bytes) => finish(null, bytes);
      job.timer = setTimeout(() => finish(new Error("Host file read timed out.")), config.sourceReadTimeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      source.queue.push(job);
      pump(source);
    });
  }

  function descriptor(source, file) {
    return { input: source.bridge.url(file.id), remote: true, fileId: file.id, codec: file.codec, label: file.name, lang: "und" };
  }

  function attach(ws, member) {
    let source;
    const timer = setTimeout(() => ws.close(1008, "Source attachment timed out"), 5000);
    ws.on("message", (data, binary) => {
      try {
        if (!source) {
          if (binary) throw new Error("Attach first.");
          const message = JSON.parse(data.toString());
          const candidate = active;
          if (!candidate || candidate.ws || message.type !== "source-attach" || message.sourceId !== candidate.id ||
              message.token !== candidate.token || (member && member.id !== candidate.owner.clientId) || !isHost(candidate.owner)) {
            throw new Error("Invalid source attachment.");
          }
          source = candidate;
          source.ws = ws;
          source.token = null;
          clearTimeout(timer);
          clearTimeout(source.attachTimer);
          source.bridge = bridge.register({ files: source.files, read: (...args) => read(source, ...args) });
          const video = source.files.get(source.videoId);
          room.media.select(source.bridge.url(video.id), video.name);
          room.state.sourceId = source.id;
          send(ws, { type: "source-attached", sourceId: source.id });
          Promise.resolve(room.media.prepare(source.bridge.url(video.id), source.captionIds.map((id) => descriptor(source, source.files.get(id)))))
            .then(() => {
              if (active !== source) return;
              for (const id of source.captionIds) {
                if (!room.state.captionTracks.some((track) => track.fileId === id)) {
                  source.files.delete(id);
                  send(source.owner, { type: "source-release-file", sourceId: source.id, fileId: id });
                }
              }
            }).catch(() => unavailable(source));
          return;
        }
        if (source !== active || !isHost(source.owner)) throw new Error("Source expired.");
        if (binary) {
          if (data.length < 4 || data.length > config.sourceChunkBytes + 4) throw new Error("Invalid binary read response.");
          const job = source.pending.get(data.readUInt32BE(0));
          // Replies to cancelled or timed-out reads are harmless and cannot satisfy a new request.
          if (!job) return;
          if (data.length - 4 !== job.length) throw new Error("Incorrect read length.");
          job.succeed(data.subarray(4));
        } else {
          const message = JSON.parse(data.toString());
          if (message.type !== "source-error") throw new Error("Unexpected source message.");
          source.pending.get(message.requestId)?.fail(new Error("The host could not read the selected file."));
        }
      } catch { ws.close(1008, "Invalid source message"); }
    });
    ws.on("close", () => { clearTimeout(timer); if (source) unavailable(source); });
    ws.on("error", () => {});
  }

  async function handleControl(ws, message) {
    if (!["source-register", "captions-add", "caption-remove"].includes(message.type)) return false;
    const reply = (payload) => send(ws, { requestId: message.requestId, ...payload });
    try {
      if (!isHost(ws)) throw new Error("Only the room host can manage files and captions.");
      if (message.type === "source-register") {
        const video = validateFile(message.video);
        if (!Array.isArray(message.captions || []) || (message.captions || []).length > 8) throw new Error("Select at most eight caption files.");
        const captions = (message.captions || []).map((file) => validateFile(file, true));
        const files = new Map([video, ...captions].map((file) => [file.id, file]));
        if (files.size !== captions.length + 1) throw new Error("File IDs must be unique.");
        reset();
        room.media.reset();
        active = { id: crypto.randomUUID(), token: crypto.randomBytes(32).toString("base64url"), owner: ws,
          files, videoId: video.id, captionIds: captions.map((file) => file.id), pending: new Map(), queue: [], nextRequest: 1, closed: false };
        const source = active;
        source.attachTimer = setTimeout(() => unavailable(source), config.sourceReadTimeoutMs);
        reply({ type: "source-registered", sourceId: source.id, token: source.token, relayPath: `${room.state.basePath}/source` });
      } else {
        const source = active;
        if (!source || message.sourceId !== source.id || !room.state.mediaReady) throw new Error("The video source is not ready.");
        if (message.type === "captions-add") {
          if (!Array.isArray(message.files) || !message.files.length || message.files.length > 8) throw new Error("Select one to eight caption files.");
          const files = message.files.map((file) => validateFile(file, true));
          if (new Set(files.map((file) => file.id)).size !== files.length || files.some((file) => source.files.has(file.id))) throw new Error("File IDs must be unique.");
          if (source.files.size + files.length > 25) throw new Error("Too many pending caption files.");
          files.forEach((file) => source.files.set(file.id, file));
          try { await room.media.addCaptions(files.map((file) => descriptor(source, file))); }
          finally {
            for (const file of files) {
              if (!room.state.captionTracks.some((track) => track.fileId === file.id)) {
                source.files.delete(file.id);
                send(ws, { type: "source-release-file", sourceId: source.id, fileId: file.id });
              }
            }
          }
        } else {
          const track = await room.media.removeCaption(message.trackId);
          if (track.fileId) { source.files.delete(track.fileId); send(ws, { type: "source-release-file", sourceId: source.id, fileId: track.fileId }); }
        }
        reply({ type: "captions-managed" });
      }
    } catch (error) { reply({ type: "error", message: error.message }); }
    return true;
  }

  return { attach, handleControl, reset };
}

module.exports = { createSourceBridge, createHostSource, validateFile };
