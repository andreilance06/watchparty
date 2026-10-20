const crypto = require("crypto");
const WebSocket = require("ws");
const { createNameRegistry } = require("./names");
const { createMessageHandler } = require("./messages");
const { sessionState } = require("./state");
const { validOrigin } = require("./rooms");

function createRealtimeServer(server, { registry, config, movieSearch }) {
  const wss = new WebSocket.Server({ noServer: true, maxPayload: config.sourceChunkBytes + 4, perMessageDeflate: false });
  server.on("upgrade", (req, socket, head) => {
    const reject = (status) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    if (!validOrigin(req, config)) { reject("403 Forbidden"); return; }
    let pathname;
    try { pathname = new URL(req.url, "http://localhost").pathname; } catch { reject("400 Bad Request"); return; }
    const match = /^\/rooms\/([a-f0-9-]+)\/(ws|source)$/.exec(pathname);
    const room = match ? registry.get(match[1]) : ["/", "/ws", "/source"].includes(pathname) ? registry.defaultRoom : null;
    if (!room) { reject("404 Not Found"); return; }
    const member = room.id === "default" ? null : registry.authenticate(req, room);
    if (room.id !== "default" && !member) { reject("401 Unauthorized"); return; }
    const sourceConnection = match ? match[2] === "source" : pathname === "/source";
    if (sourceConnection && member && member.id !== room.state.hostId) { reject("403 Forbidden"); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.alive = true;
      ws.on("pong", () => { ws.alive = true; });
      ws.on("error", () => {});
      if (sourceConnection) room.source.attach(ws, member);
      else attachControl(ws, room, member);
    });
  });

  function attachControl(ws, room, member) {
    const { state, transport, media } = room;
    const { send, broadcast } = transport;
    const { availableGuestName } = createNameRegistry(state.clients);
    const { handleMessage, updatePresence } = createMessageHandler({ state, transport, media, movieSearch });
    ws.clientId = member?.id || crypto.randomUUID();
    const previous = state.clients.get(ws.clientId);
    state.clients.set(ws.clientId, {
      ws, role: state.hostId === ws.clientId || !state.hostId ? "host" : "viewer",
      name: previous?.name || member?.name || availableGuestName(ws.clientId)
    });
    if (previous) {
      if (state.hostId === ws.clientId) {
        room.source.reset(); media.reset(); broadcast(sessionState(state, "source"));
      }
      previous.ws.close(4000, "Connection replaced");
    }
    registry.scheduleExpiry(room);
    ws.on("message", async (data, binary) => {
      if (state.clients.get(ws.clientId)?.ws !== ws) return;
      try {
        if (binary || data.length > 16384) throw new Error("Invalid control message.");
        const message = JSON.parse(data.toString());
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid message.");
        if (!await room.source.handleControl(ws, message)) handleMessage(ws, message);
      } catch { send(ws, { type: "error", message: "Invalid message." }); }
    });
    ws.on("close", () => {
      const client = state.clients.get(ws.clientId);
      if (client?.ws !== ws) return;
      if (member) member.name = client.name;
      const wasHost = ws.clientId === state.hostId;
      state.clients.delete(ws.clientId);
      state.videoVotes.delete(ws.clientId);
      if (state.shuttingDown) return;
      if (wasHost) {
        state.hostId = null;
        room.source.reset();
        media.reset();
        broadcast({ type: "host-left" });
        const next = state.clients.entries().next().value;
        if (next) {
          state.hostId = next[0];
          next[1].role = "host";
          send(next[1].ws, { type: "role", role: "host", hostId: state.hostId, clientId: next[0], viewerCount: state.clients.size });
          send(next[1].ws, sessionState(state, "join"));
        }
      }
      updatePresence();
      registry.scheduleExpiry(room);
    });
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) ws.terminate();
      else { ws.alive = false; ws.ping(); }
    }
  }, 30000);
  heartbeat.unref?.();
  wss.on("close", () => clearInterval(heartbeat));
  return wss;
}

module.exports = { createRealtimeServer };
