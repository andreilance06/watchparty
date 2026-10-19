import { createClientId } from "./utils/client-id.js";

// File objects stay in this browser. The server can request only declared ranges.
export function createHostFiles({ send, report }) {
  const files = new Map(), requests = new Map();
  let relay, sourceId = null, role = "viewer", generation = 0;
  const captionPattern = /\.(srt|vtt|ass|ssa)$/i;

  function clear(closeRelay = true) {
    generation++;
    sourceId = null;
    if (closeRelay) relay?.close();
    relay = null;
    files.clear();
    for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new Error("The host connection changed.")); }
    requests.clear();
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
    if (role !== "host") return;
    const input = document.createElement("input");
    input.type = "file"; input.multiple = true; input.accept = accept;
    input.hidden = true;
    document.body.appendChild(input);
    input.addEventListener("change", () => {
      const chosen = [...(input.files || [])];
      input.remove();
      if (chosen.length) onFiles(chosen).catch((error) => report(error.message));
    }, { once: true });
    input.addEventListener("cancel", () => input.remove(), { once: true });
    input.click();
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
    if (current !== generation || role !== "host") return;
    sourceId = reply.sourceId;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}${reply.relayPath}`);
    relay = socket;
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "source-attach", sourceId, token: reply.token })));
    socket.addEventListener("message", async (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
        if (message.type === "source-attached") return;
        const file = files.get(message.fileId);
        if (message.type !== "source-read" || !file || !Number.isInteger(message.requestId) || message.requestId < 1 || message.requestId > 0xffffffff ||
            !Number.isSafeInteger(message.offset) || !Number.isInteger(message.length) || message.offset < 0 || message.length < 1 || message.length > 256 * 1024 || message.offset + message.length > file.size) {
          throw new Error("Invalid file range.");
        }
        const bytes = await file.slice(message.offset, message.offset + message.length).arrayBuffer();
        while (socket.readyState === WebSocket.OPEN && socket.bufferedAmount > 1024 * 1024) await new Promise((resolve) => setTimeout(resolve, 20));
        if (current !== generation || socket.readyState !== WebSocket.OPEN) return;
        const frame = new Uint8Array(4 + bytes.byteLength);
        new DataView(frame.buffer).setUint32(0, message.requestId);
        frame.set(new Uint8Array(bytes), 4);
        socket.send(frame);
      } catch {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "source-error", requestId: message?.requestId }));
      }
    });
    socket.addEventListener("close", () => {
      if (current === generation) { clear(); report("The file connection closed. Choose the video again."); }
    });
    socket.addEventListener("error", () => {});
  }

  async function addFiles(chosen) {
    if (!sourceId) throw new Error("Choose a video first.");
    if (chosen.length > 8 || chosen.some((file) => !captionPattern.test(file.name) || !file.size)) throw new Error("Choose one to eight nonempty subtitle files.");
    const declared = chosen.map(declare);
    try { await request({ type: "captions-add", sourceId, files: declared }); }
    catch (error) { declared.forEach((file) => files.delete(file.id)); throw error; }
  }

  function handleMessage(message) {
    if (message.type === "source-release-file") {
      if (message.sourceId === sourceId) files.delete(message.fileId);
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
    setRole(next) { if (role !== next) clear(); role = next; },
    chooseVideo: () => pick("video/*,.mkv,.avi,.ts,.mts,.m2ts,.mpg,.mpeg,.flv,.wmv,.srt,.vtt,.ass,.ssa", selectFiles),
    chooseCaptions: () => pick(".srt,.vtt,.ass,.ssa", addFiles),
    async removeCaption(trackId) {
      if (!trackId || !sourceId) return;
      try { await request({ type: "caption-remove", sourceId, trackId }); } catch (error) { report(error.message); }
    }
  };
}
