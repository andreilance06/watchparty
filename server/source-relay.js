const http = require("node:http");
const crypto = require("node:crypto");
const { sessionState } = require("./state");
const { serveByteSource } = require("./http/ranges");

// Only FFmpeg sees these capability URLs. The browser supplies bytes, never URLs.
function createSourceBridge(config) {
  const entries = new Map();
  let origin;
  const server = http.createServer(async (req, res) => {
    const [, token, fileId, extra] = req.url.split("?")[0].split("/");
    const entry = !extra && entries.get(token);
    const file = entry?.files.get(fileId);
    if (!file || !["GET", "HEAD"].includes(req.method)) { res.writeHead(404); res.end(); return; }
    await serveByteSource(req, res, { size: file.size, chunkBytes: config.sourceChunkBytes,
      concurrency: config.sourceMaxReads, read: (offset, length, signal) => entry.read(fileId, offset, length, signal) });
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
  const connectedOwner = provider => room.state.clients.get(provider.owner.clientId)?.ws === provider.owner;

  function reset() {
    const source = active;
    active = null;
    if (!source) return;
    source.closed = true;
    source.cache.clear();
    for (const entry of source.reads.values()) entry.controller.abort();
    source.reads.clear();
    for (const provider of source.providers.values()) {
      clearTimeout(provider.attachTimer);
      provider.rejectReady?.(new Error("Source replaced."));
      send(provider.owner, { type: "source-ended", sourceId: source.id });
      provider.ws?.close(1000, "Source replaced");
    }
    source.bridge?.close();
    for (const job of [...source.pending.values(), ...source.queue]) job.fail(new Error("Source is no longer available."));
  }

  function unavailable(source) {
    if (active !== source || source.closed) return;
    reset();
    room.media.reset();
    room.transport.broadcast(sessionState(room.state, "source"));
    room.transport.broadcast({ type: "media-error", message: "The video provider disconnected. The host can choose another video." });
  }

  function retireProvider(source, provider, error = new Error("Caption file connection closed.")) {
    if (!source.providers.delete(provider.id)) return;
    clearTimeout(provider.attachTimer); provider.rejectReady?.(error);
    for (const job of [...source.pending.values(), ...source.queue]) if (job.provider === provider) job.fail(error);
    for (const fileId of provider.fileIds) {
      source.files.delete(fileId);
      send(provider.owner, { type: "source-release-file", sourceId: source.id, fileId });
    }
    provider.ws?.close(1000, "Caption files released");
  }

  function disconnectControl(ws) {
    const source = active;
    if (!source) return;
    if (source.owner === ws) { unavailable(source); return; }
    for (const provider of [...source.providers.values()]) if (provider.owner === ws) retireProvider(source, provider);
  }

  function pump(source) {
    if (source.closed) return;
    while (source.pending.size < config.sourceMaxReads && source.queue.length) {
      const preferred = source.queue.findIndex(job => job.caption === Boolean(source.preferCaptions));
      const job = source.queue.splice(preferred < 0 ? 0 : preferred, 1)[0];
      if (job.done) continue;
      if (job.provider.ws?.readyState !== 1) { job.fail(new Error("File provider unavailable.")); continue; }
      source.pending.set(job.id, job);
      if (!job.caption && job.fileId === source.videoId) {
        const transfer = source.transfer ||= { active: 0, bytes: 0, started: performance.now() };
        if (!transfer.active) transfer.started = performance.now();
        transfer.active++; job.measured = true;
      }
      source.preferCaptions = !job.caption;
      send(job.provider.ws, { type: job.ranges ? "source-read-batch" : "source-read", requestId: job.id, fileId: job.fileId,
        ...(job.ranges ? { ranges: job.ranges } : { offset: job.offset, length: job.length }) });
    }
  }

  function read(source, fileId, offset, length, signal, caption = false, ranges = null) {
    return new Promise((resolve, reject) => {
      const provider = source.providers.get(source.files.get(fileId)?.providerId || source.id);
      if (source.closed || provider?.ws?.readyState !== 1 || signal.aborted) { reject(new Error("Source unavailable.")); return; }
      if (source.queue.length >= 64) { reject(new Error("Source is busy.")); return; }
      const id = source.nextRequest++;
      if (id > 0xffffffff) { reject(new Error("Source request limit reached. Reselect the video.")); return; }
      const job = { id, fileId, offset, length, provider, done: false, caption, ranges };
      const finish = (error, bytes) => {
        if (job.done) return;
        job.done = true;
        if (job.measured) {
          const transfer = source.transfer;
          transfer.active--;
          if (!error) transfer.bytes += bytes.length;
          const elapsed = performance.now() - transfer.started;
          if (elapsed >= 250 || !transfer.active) {
            if (elapsed >= 10 && transfer.bytes >= 32768 && !source.closed) {
              const rate = transfer.bytes * 8000 / elapsed;
              const previous = room.state.sourcePerformance;
              room.state.sourcePerformance = { bps: previous ? previous.bps * 0.7 + rate * 0.3 : rate,
                sampledAt: Date.now(), samples: (previous?.samples || 0) + 1 };
            }
            transfer.bytes = 0; transfer.started = performance.now();
          }
        }
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

  // Subtitle parsers skip media payloads using tiny header reads. Expanding
  // those requests to cache pages would pull the video through the relay again.
  async function preciseReadMany(source, fileId, ranges, signal) {
    const file = source.files.get(fileId);
    if (!file || source.closed || signal.aborted || !Array.isArray(ranges) || ranges.length > 64) throw new Error("Invalid caption source range.");
    const misses = [], outputs = ranges.map(() => []);
    let total = 0;
    for (const [index, { offset, length }] of ranges.entries()) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || offset + length > file.size) throw new Error("Invalid caption source range.");
      total += length;
      if (total > 256 * 1024) throw new Error("Caption read batch is too large.");
      for (let at = offset; at < offset + length;) {
        const page = Math.floor(at / config.sourceChunkBytes) * config.sourceChunkBytes;
        const count = Math.min(config.sourceChunkBytes - at % config.sourceChunkBytes, offset + length - at);
        const cached = source.cache.get(`${fileId}:${page}`), slot = outputs[index].length;
        outputs[index].push(cached ? cached.subarray(at - page, at - page + count) : null);
        if (cached) source.captionMetrics.cacheHitBytes += count;
        else misses.push({ offset: at, length: count, index, slot });
        at += count;
      }
    }
    const provider = source.providers.get(file.providerId || source.id);
    for (let at = 0; at < misses.length;) {
      const batch = []; let length = 0;
      while (at < misses.length && batch.length < 64 && length + misses[at].length <= config.sourceChunkBytes) {
        length += misses[at].length; batch.push(misses[at++]);
      }
      signal.throwIfAborted();
      source.captionMetrics.ranges += batch.length; source.captionMetrics.bytes += length;
      if (provider.batchReads) {
        source.captionMetrics.requests++;
        const bytes = await read(source, fileId, 0, length, signal, true, batch.map(({ offset, length }) => ({ offset, length })));
        let start = 0;
        for (const piece of batch) { outputs[piece.index][piece.slot] = bytes.subarray(start, start + piece.length); start += piece.length; }
      } else {
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(4, batch.length) }, async () => {
          while (next < batch.length) {
            const piece = batch[next++]; source.captionMetrics.requests++;
            outputs[piece.index][piece.slot] = await read(source, fileId, piece.offset, piece.length, signal, true);
          }
        }));
      }
    }
    signal.throwIfAborted();
    return outputs.map(chunks => chunks.length === 1 ? chunks[0] : Buffer.concat(chunks));
  }

  function cachedRead(source, fileId, offset, length, signal) {
    const file = source.files.get(fileId);
    if (!file) return Promise.reject(new Error("File is no longer available."));
    const page = Math.floor(offset / config.sourceChunkBytes) * config.sourceChunkBytes;
    const key = `${fileId}:${page}`;
    const cached = source.cache.get(key);
    if (cached) {
      source.cache.delete(key); source.cache.set(key, cached);
      return Promise.resolve(cached.subarray(offset - page, offset - page + length));
    }
    let entry = source.reads.get(key);
    if (!entry) {
      const controller = new AbortController();
      entry = { controller, users: 0 };
      entry.promise = read(source, fileId, page, Math.min(config.sourceChunkBytes, file.size - page), controller.signal)
        .then((bytes) => {
          if (!source.closed) {
            source.cache.set(key, bytes);
            const maxPages = Math.max(1, Math.floor(config.sourceCacheBytes / config.sourceChunkBytes));
            while (source.cache.size > maxPages) source.cache.delete(source.cache.keys().next().value);
          }
          return bytes;
        }).finally(() => { if (source.reads.get(key) === entry) source.reads.delete(key); });
      source.reads.set(key, entry);
    }
    entry.users++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error, bytes) => {
        if (finished) return;
        finished = true; signal.removeEventListener("abort", abort);
        if (--entry.users === 0) entry.controller.abort();
        if (error) reject(error); else resolve(bytes.subarray(offset - page, offset - page + length));
      };
      const abort = () => finish(new Error("Read cancelled."));
      entry.promise.then((bytes) => finish(null, bytes), (error) => finish(error));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  async function serveOriginal(req, res, url) {
    const source = active;
    if (!source || source.closed || !room.state.mediaReady || Number(url.searchParams.get("v")) !== room.state.mediaVersion) {
      res.writeHead(404); res.end("Source is no longer available"); return;
    }
    const file = source.files.get(source.videoId);
    await serveByteSource(req, res, { size: file.size, type: room.state.mediaInfo?.mime,
      chunkBytes: config.sourceChunkBytes, concurrency: config.sourceMaxReads,
      read: (offset, length, signal) => cachedRead(source, file.id, offset, length, signal) });
  }

  function attach(ws, member) {
    let source, provider;
    const timer = setTimeout(() => ws.close(1008, "Source attachment timed out"), 5000);
    ws.on("message", (data, binary) => {
      try {
        if (!source) {
          if (binary) throw new Error("Attach first.");
          const message = JSON.parse(data.toString());
          const candidate = active;
          const selected = candidate?.providers.get(message.providerId || candidate.id);
          if (!candidate || !selected || selected.ws || message.type !== "source-attach" || message.sourceId !== candidate.id ||
              message.token !== selected.token || (member && member.id !== selected.owner.clientId) || !connectedOwner(selected)) {
            throw new Error("Invalid source attachment.");
          }
          source = candidate;
          provider = selected;
          provider.ws = ws;
          provider.batchReads = Array.isArray(message.capabilities) && message.capabilities.includes("batch-reads-v1");
          provider.token = null;
          clearTimeout(timer);
          clearTimeout(provider.attachTimer);
          send(ws, { type: "source-attached", sourceId: source.id, providerId: provider.id });
          if (provider !== source) { provider.resolveReady(); return; }
          source.bridge = bridge.register({ files: source.files, read: (...args) => cachedRead(source, ...args) });
          const video = source.files.get(source.videoId);
          room.state.sourceId = source.id;
          room.state.sourceOwnerId = source.owner.clientId;
          room.media.select(source.bridge.url(video.id), video.name);
          Promise.resolve(room.media.prepare(source.bridge.url(video.id), source.captionIds.map((id) => descriptor(source, source.files.get(id))), {
            size: video.size, metrics: source.captionMetrics,
            read: async (offset, length, signal) => (await preciseReadMany(source, video.id, [{ offset, length }], signal))[0],
            readMany: (ranges, signal) => preciseReadMany(source, video.id, ranges, signal)
          }))
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
        if (source !== active || !connectedOwner(provider) || !source.providers.has(provider.id)) throw new Error("Source expired.");
        if (binary) {
          if (data.length < 4 || data.length > config.sourceChunkBytes + 4) throw new Error("Invalid binary read response.");
          const job = source.pending.get(data.readUInt32BE(0));
          // Replies to cancelled or timed-out reads are harmless and cannot satisfy a new request.
          if (!job) return;
          if (job.provider !== provider) throw new Error("Read belongs to another file provider.");
          if (data.length - 4 !== job.length) throw new Error("Incorrect read length.");
          job.succeed(data.subarray(4));
        } else {
          const message = JSON.parse(data.toString());
          if (message.type !== "source-error") throw new Error("Unexpected source message.");
          const job = source.pending.get(message.requestId);
          if (job && job.provider !== provider) throw new Error("Read belongs to another file provider.");
          job?.fail(new Error("The provider could not read the selected file."));
        }
      } catch { ws.close(1008, "Invalid source message"); }
    });
    ws.on("close", () => {
      clearTimeout(timer);
      if (source && provider === source) unavailable(source);
      else if (source && provider) retireProvider(source, provider);
    });
    ws.on("error", () => {});
  }

  async function handleControl(ws, message) {
    if (!["source-register", "caption-provider-register", "captions-add", "caption-remove"].includes(message.type)) return false;
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
          files, videoId: video.id, captionIds: captions.map((file) => file.id), pending: new Map(), queue: [],
          cache: new Map(), reads: new Map(), nextRequest: 1, closed: false,
          captionMetrics: { requests: 0, ranges: 0, bytes: 0, cacheHitBytes: 0 } };
        const source = active;
        source.providers = new Map([[source.id, source]]);
        source.attachTimer = setTimeout(() => unavailable(source), config.sourceReadTimeoutMs);
        reply({ type: "source-registered", sourceId: source.id, token: source.token, relayPath: `${room.state.basePath}/source` });
      } else {
        const source = active;
        if (!source || message.sourceId !== source.id || !room.state.mediaReady) throw new Error("The video source is not ready.");
        if (message.type === "caption-provider-register") {
          if (!Array.isArray(message.files) || !message.files.length || message.files.length > 8) throw new Error("Select one to eight caption files.");
          const files = message.files.map(file => validateFile(file, true));
          if (new Set(files.map(file => file.id)).size !== files.length || files.some(file => source.files.has(file.id)) || source.files.size + files.length > 25) throw new Error("Caption file IDs must be unique and within the room limit.");
          const provider = { id: crypto.randomUUID(), token: crypto.randomBytes(32).toString("base64url"), owner: ws, fileIds: files.map(file => file.id) };
          provider.ready = new Promise((resolve, reject) => { provider.resolveReady = resolve; provider.rejectReady = reject; });
          provider.ready.catch(() => {});
          source.providers.set(provider.id, provider);
          for (const file of files) source.files.set(file.id, { ...file, providerId: provider.id });
          provider.attachTimer = setTimeout(() => retireProvider(source, provider), config.sourceReadTimeoutMs);
          reply({ type: "caption-provider-registered", sourceId: source.id, providerId: provider.id, token: provider.token, relayPath: `${room.state.basePath}/source` });
        } else if (message.type === "captions-add") {
          if (!Array.isArray(message.files) || !message.files.length || message.files.length > 8) throw new Error("Select one to eight caption files.");
          const files = message.files.map((file) => validateFile(file, true));
          if (new Set(files.map(file => file.id)).size !== files.length) throw new Error("File IDs must be unique.");
          const provider = message.providerId ? source.providers.get(message.providerId) : source;
          if (!provider || provider.owner !== ws) throw new Error("Caption files belong to another provider.");
          if (provider !== source) {
            if (files.length !== provider.fileIds.length || files.some(file => !provider.fileIds.includes(file.id) || file.size !== source.files.get(file.id)?.size || file.name !== source.files.get(file.id)?.name)) throw new Error("Caption registration changed.");
            await provider.ready;
            if (active !== source || !isHost(ws)) throw new Error("The source or host changed.");
          } else {
            if (new Set(files.map((file) => file.id)).size !== files.length || files.some((file) => source.files.has(file.id))) throw new Error("File IDs must be unique.");
            if (source.files.size + files.length > 25) throw new Error("Too many pending caption files.");
            files.forEach((file) => source.files.set(file.id, file));
          }
          try { await room.media.addCaptions(files.map((file) => descriptor(source, file))); }
          finally {
            if (provider !== source) retireProvider(source, provider);
            for (const file of files) {
              if (!room.state.captionTracks.some((track) => track.fileId === file.id)) {
                source.files.delete(file.id);
                send(ws, { type: "source-release-file", sourceId: source.id, fileId: file.id });
              }
            }
          }
        } else {
          const track = await room.media.removeCaption(message.trackId);
          if (track.fileId) {
            const file = source.files.get(track.fileId);
            const provider = file && source.providers.get(file.providerId || source.id);
            source.files.delete(track.fileId);
            if (provider) send(provider.owner, { type: "source-release-file", sourceId: source.id, fileId: track.fileId });
          }
        }
        if (message.type !== "caption-provider-register") reply({ type: "captions-managed" });
      }
    } catch (error) { reply({ type: "error", message: error.message }); }
    return true;
  }

  return { attach, handleControl, reset, serveOriginal, disconnectControl, isOwner: ws => active?.owner === ws };
}

module.exports = { createSourceBridge, createHostSource, validateFile };
