const crypto = require("crypto");
const WebSocket = require("ws");
const { createNameRegistry } = require("./names");
const { createMessageHandler } = require("./messages");
const { sessionState } = require("./state");

function createRealtimeServer(server, { state, transport, media }) {
  const wss = new WebSocket.Server({ server });
  const { send, broadcast } = transport;
  const { availableGuestName } = createNameRegistry(state.clients);
  const { handleMessage, updatePresence } = createMessageHandler({ state, transport, media });

  wss.on("connection", (ws) => {
    ws.clientId = crypto.randomUUID();
    state.clients.set(ws.clientId, {
      ws,
      role: state.hostId ? "viewer" : "host",
      name: availableGuestName(ws.clientId)
    });
    ws.on("message", (data) => {
      try { handleMessage(ws, JSON.parse(data.toString())); }
      catch { send(ws, { type: "error", message: "Invalid message." }); }
    });
    ws.on("close", () => {
      const wasHost = ws.clientId === state.hostId;
      state.clients.delete(ws.clientId);
      if (state.shuttingDown) return;
      if (wasHost) {
        state.hostId = null;
        media.reset();
        broadcast({ type: "host-left" });
        const next = state.clients.entries().next().value;
        if (next) {
          state.hostId = next[0];
          next[1].role = "host";
          send(next[1].ws, {
            type: "role", role: "host", hostId: state.hostId,
            clientId: next[0], viewerCount: state.clients.size
          });
          send(next[1].ws, sessionState(state, "join"));
        }
      }
      updatePresence();
    });
  });

  return wss;
}

module.exports = { createRealtimeServer };
