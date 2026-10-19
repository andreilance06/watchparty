const WebSocket = require("ws");

async function connectPeer(url, name, options = {}) {
  const ws = new WebSocket(url, options);
  const backlog = [];
  const messages = [];
  const waiting = [];

  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    messages.push(message);
    const index = waiting.findIndex((item) => item.matches(message));
    if (index < 0) { backlog.push(message); return; }
    const [item] = waiting.splice(index, 1);
    clearTimeout(item.timer);
    item.resolve(message);
  });

  function next(type, predicate = () => true) {
    const matches = (message) => message.type === type && predicate(message);
    const index = backlog.findIndex(matches);
    if (index >= 0) return Promise.resolve(backlog.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const item = { matches, resolve, timer: null };
      item.timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(item), 1);
        reject(new Error(`Timed out waiting for ${type}`));
      }, 10000);
      waiting.push(item);
    });
  }

  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "join", name }));
  const role = await next("role");
  return { ws, role, next, messages, send: (message) => ws.send(JSON.stringify(message)) };
}

async function serveHostFiles(peer, origin, video, captions = [], options = {}) {
  const crypto = require("node:crypto");
  const files = new Map();
  const reads = [];
  const declare = (file) => {
    const id = crypto.randomUUID();
    files.set(id, file.bytes);
    return { id, name: file.name, size: file.bytes.length };
  };
  const videoMetadata = declare(video);
  const captionMetadata = captions.map(declare);
  const requestId = crypto.randomUUID();
  peer.send({ type: "source-register", requestId, video: videoMetadata, captions: captionMetadata });
  const registered = await peer.next("source-registered", (message) => message.requestId === requestId);
  const ws = new WebSocket(origin.replace(/^http/, "ws") + registered.relayPath, options);
  ws.on("error", () => {});
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== "source-read") return;
    reads.push(message);
    const bytes = files.get(message.fileId);
    const frame = Buffer.alloc(4 + message.length);
    frame.writeUInt32BE(message.requestId);
    bytes.copy(frame, 4, message.offset, message.offset + message.length);
    ws.send(frame);
  });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.send(JSON.stringify({ type: "source-attach", sourceId: registered.sourceId, token: registered.token }));
  return { ws, reads, files, declare, sourceId: registered.sourceId };
}

module.exports = { connectPeer, serveHostFiles };
