const crypto = require("crypto");
const WebSocket = require("ws");
const { createNameRegistry } = require("./names");
const { createMessageHandler } = require("./messages");
const { validOrigin } = require("./rooms");
const { permissionKey } = require("./permissions");

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
    try { registry.assertAdmission(req, room); } catch { reject("403 Forbidden"); return; }
    const member = room.id === "default" ? null : registry.authenticate(req, room);
    if (room.id !== "default" && !member) { reject("401 Unauthorized"); return; }
    const sourceConnection = match ? match[2] === "source" : pathname === "/source";
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.alive = true;
      ws.on("pong", () => { ws.alive = true; });
      ws.on("error", () => {});
      if (sourceConnection) room.source.attach(ws, member);
      else attachControl(ws, room, member, registry.browserIdentity(req));
    });
  });

  function attachControl(ws, room, member, identity) {
    const { state, transport, media } = room;
    const { send } = transport;
    const { availableGuestName } = createNameRegistry(state.clients);
    const { handleMessage, updatePresence } = createMessageHandler({ state, transport, media, movieSearch });
    room.moderation.setPublish(updatePresence);
    ws.clientId = member?.id || crypto.randomUUID();
    if (member) member.permissionIdentity ||= identity || `member:${member.id}`;
    const previous = state.clients.get(ws.clientId);
    state.clients.set(ws.clientId, {
      ws, role: state.hostId === ws.clientId || !state.hostId ? "host" : "viewer",
      name: previous?.name || member?.name || availableGuestName(ws.clientId),
      permissionIdentity: member?.permissionIdentity || identity,
      hasMemberName: Boolean(member?.name)
    });
    if (state.clients.get(ws.clientId).role === "host") {
      state.viewerPermissions.delete(permissionKey(state.clients.get(ws.clientId), ws.clientId));
    }
    if (previous) {
      room.source.disconnectControl(previous.ws);
      previous.ws.close(4000, "Connection replaced");
    }
    registry.scheduleExpiry(room);
    ws.on("message", async (data, binary) => {
      if (state.clients.get(ws.clientId)?.ws !== ws) return;
      try {
        if (binary || data.length > 16384) throw new Error("Invalid control message.");
        const message = JSON.parse(data.toString());
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid message.");
        if (room.moderation.handle(ws, message)) return;
        if (!await room.source.handleControl(ws, message) && state.clients.get(ws.clientId)?.ws === ws) handleMessage(ws, message);
      } catch { send(ws, { type: "error", message: "Invalid message." }); }
    });
    ws.on("close", () => {
      const client = state.clients.get(ws.clientId);
      if (client?.ws !== ws) return;
      if (member) member.name = client.name;
      const wasHost = ws.clientId === state.hostId;
      room.source.disconnectControl(ws);
      state.clients.delete(ws.clientId);
      state.videoVotes.delete(ws.clientId);
      if (state.shuttingDown) return;
      if (wasHost) {
        room.moderation.releaseHost(ws.clientId);
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
