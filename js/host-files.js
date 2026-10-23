import { createClientId } from "./utils/client-id.js";

// File objects stay in this browser. The server can request only declared ranges.
export function createHostFiles({ send, report }) {
  const files = new Map(), requests = new Map();
  const captionRelays = new Set();
  const readQueue = [];
  let activeReads = 0;
  let relay, sourceId = null, role = "viewer", generation = 0;
  let activeSourceId = null;
  let picker = null;
  const captionPattern = /\.(srt|vtt|ass|ssa)$/i;

  function clear(closeRelay = true) {
    picker?.cancel();
    generation++;
    sourceId = null;
    activeSourceId = null;
    for (const socket of captionRelays) socket.close();
    captionRelays.clear();
    if (closeRelay) relay?.close();
    relay = null;
    files.clear();
    for (const job of readQueue.splice(0)) job.reject(new Error("The host connection changed."));
    for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new Error("The host connection changed.")); }
    requests.clear();
  }

  function readRange(file, offset, length, socket, current) {
    return new Promise((resolve, reject) => {
      readQueue.push({ file, offset, length, socket, current, resolve, reject });
      pumpReads();
    });
  }

  function pumpReads() {
    while (activeReads < 4 && readQueue.length) {
      const job = readQueue.shift();
      if (job.current !== generation || job.socket.readyState !== WebSocket.OPEN) { job.reject(new Error("Read cancelled.")); continue; }
      activeReads++;
      Promise.resolve().then(() => job.file.slice(job.offset, job.offset + job.length).arrayBuffer())
        .then(job.resolve, job.reject).finally(() => { activeReads--; pumpReads(); });
    }
  }

  function request(message) {
    const requestId = createClientId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { requests.delete(requestId); reject(new Error("The server did not respond to the file request.")); }, 30000);
      requests.set(requestId, { resolve, reject, timer });
      if (send({ ...message, requestId }) === false) {
        clearTimeout(timer); requests.delete(requestId); reject(new Error("Connect to the room first."));
      }
    });
  }

  function declare(file) {
    const id = createClientId();
    files.set(id, file);
    return { id, name: file.name, size: file.size, type: file.type };
  }

  function pick(accept, onFiles) {
    if (role !== "host") return Promise.resolve();
    if (picker) return picker.promise;
    const current = generation, target = activeSourceId;
    let resolve, focusTimer;
    const promise = new Promise(done => { resolve = done; });
    const input = document.createElement("input");
    input.type = "file"; input.multiple = true; input.accept = accept;
    input.hidden = true;
    document.body.appendChild(input);
    const stillCurrent = () => current === generation && target === activeSourceId && role === "host";
    function finish(chosen = []) {
      clearTimeout(focusTimer);
      window.removeEventListener("focus", refocused);
      input.removeEventListener("change", change);
      input.removeEventListener("cancel", cancel);
      input.remove();
      if (picker?.promise === promise) picker = null;
      if (!stillCurrent() || !chosen.length) { resolve(); return; }
      Promise.resolve().then(() => { if (stillCurrent()) return onFiles(chosen); })
        .catch(error => { if (role === "host" && (onFiles === selectFiles || stillCurrent())) report(error.message); }).finally(resolve);
    }
    const change = () => finish([...(input.files || [])]);
    const cancel = () => finish();
    const refocused = () => {
      // Some browser/OS combinations return focus without firing cancel. Give
      // change a chance to run before treating an empty picker as cancelled.
      focusTimer = setTimeout(() => { if (picker?.promise === promise && !input.files?.length) cancel(); }, 300);
    };
    picker = { promise, cancel };
    input.addEventListener("change", change, { once: true });
    input.addEventListener("cancel", cancel, { once: true });
    window.addEventListener("focus", refocused, { once: true });
    try { input.click(); } catch (error) { cancel(); report(error.message); }
    return promise;
  }

  async function selectFiles(chosen) {
    const videos = chosen.filter((file) => !captionPattern.test(file.name));
    const captions = chosen.filter((file) => captionPattern.test(file.name));
    if (videos.length !== 1 || captions.length > 8) throw new Error("Choose one video and up to eight caption files.");
    if (chosen.some((file) => !file.size)) throw new Error("Selected files must not be empty.");
    const previous = relay;
    // Let registration invalidate the old source before closing its data socket.
    clear(false);
    const current = generation;
    const video = declare(videos[0]);
    let reply;
    try { reply = await request({ type: "source-register", video, captions: captions.map(declare) }); }
    catch (error) { previous?.close(); if (current === generation) clear(); throw error; }
    previous?.close();
    if (current !== generation) return;
    sourceId = activeSourceId = reply.sourceId;
    relay = openRelay(reply, current).socket;
  }

  function openRelay(reply, current, captionOnly = false) {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}${reply.relayPath}`);
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    ready.catch(() => {});
    if (captionOnly) captionRelays.add(socket);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "source-attach", sourceId: reply.sourceId, token: reply.token,
      capabilities: ["batch-reads-v1"], ...(reply.providerId ? { providerId: reply.providerId } : {}) })));
    socket.addEventListener("message", async (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
        if (message.type === "source-attached") { resolveReady(); return; }
        const file = files.get(message.fileId);
        const ranges = message.type === "source-read-batch" ? message.ranges : [{ offset: message.offset, length: message.length }];
        if (!["source-read", "source-read-batch"].includes(message.type) || !file || !Number.isInteger(message.requestId) || message.requestId < 1 || message.requestId > 0xffffffff ||
            !Array.isArray(ranges) || !ranges.length || ranges.length > 64 || ranges.some(range => !range || !Number.isSafeInteger(range.offset) || !Number.isInteger(range.length) ||
              range.offset < 0 || range.length < 1 || range.length > 256 * 1024 || range.offset + range.length > file.size)) {
          throw new Error("Invalid file range.");
        }
        const length = ranges.reduce((sum, range) => sum + range.length, 0);
        if (length > 256 * 1024) throw new Error("Invalid file range batch.");
        const buffers = await Promise.all(ranges.map(range => readRange(file, range.offset, range.length, socket, current)));
        while (socket.readyState === WebSocket.OPEN && socket.bufferedAmount > 1024 * 1024) await new Promise((resolve) => setTimeout(resolve, 20));
        if (current !== generation || socket.readyState !== WebSocket.OPEN) return;
        const frame = new Uint8Array(4 + length);
        new DataView(frame.buffer).setUint32(0, message.requestId);
        let offset = 4;
        for (const bytes of buffers) { frame.set(new Uint8Array(bytes), offset); offset += bytes.byteLength; }
        socket.send(frame);
      } catch {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "source-error", requestId: message?.requestId }));
      }
    });
    socket.addEventListener("close", () => {
      rejectReady(new Error("The file connection closed."));
      if (captionOnly) captionRelays.delete(socket);
      else if (current === generation && relay === socket) { clear(); report("The file connection closed. The host can choose another video."); }
    });
    socket.addEventListener("error", () => {});
    return { socket, ready };
  }

  async function addFiles(chosen) {
    if (!activeSourceId) throw new Error("Choose a video first.");
    if (chosen.length > 8 || chosen.some((file) => !captionPattern.test(file.name) || !file.size)) throw new Error("Choose one to eight nonempty subtitle files.");
    const declared = chosen.map(declare);
    let captionRelay;
    try {
      if (sourceId === activeSourceId) await request({ type: "captions-add", sourceId, files: declared });
      else {
        const current = generation, target = activeSourceId;
        const registered = await request({ type: "caption-provider-register", sourceId: target, files: declared });
        if (current !== generation || activeSourceId !== target || role !== "host") throw new Error("The source or host changed.");
        const opened = openRelay(registered, current, true); captionRelay = opened.socket;
        await opened.ready;
        await request({ type: "captions-add", sourceId: target, providerId: registered.providerId, files: declared });
      }
    }
    catch (error) { declared.forEach((file) => files.delete(file.id)); throw error; }
    finally { captionRelay?.close(); }
  }

  function handleMessage(message) {
    if (message.type === "source-ended") {
      if (message.sourceId === sourceId || message.sourceId === activeSourceId) clear();
      return true;
    }
    if (message.type === "source-release-file") {
      if (message.sourceId === sourceId || message.sourceId === activeSourceId) files.delete(message.fileId);
      return true;
    }
    const pending = requests.get(message.requestId);
    if (!pending) return false;
    clearTimeout(pending.timer); requests.delete(message.requestId);
    if (message.type === "error") pending.reject(new Error(message.message)); else pending.resolve(message);
    return true;
  }

  return {
    handleMessage, disconnect: clear,
    setRole(next) { if (next !== role) picker?.cancel(); role = next; },
    setSession(state) {
      if (state.sourceId === undefined) return;
      if (activeSourceId !== state.sourceId) picker?.cancel();
      if (sourceId && sourceId !== state.sourceId) clear();
      activeSourceId = state.sourceId;
    },
    chooseVideo: () => pick("video/*,.mkv,.webm,.mp4,.m4v,.mov,.3gp,.3g2,.avi,.ogm,.ogv,.ogg,.ts,.mts,.m2ts,.mpg,.mpeg,.flv,.wmv,.srt,.vtt,.ass,.ssa", selectFiles),
    chooseCaptions: () => pick(".srt,.vtt,.ass,.ssa", addFiles),
    async removeCaption(trackId) {
      if (!trackId || !activeSourceId || role !== "host") return;
      try { await request({ type: "caption-remove", sourceId: activeSourceId, trackId }); } catch (error) { report(error.message); }
    }
  };
}
