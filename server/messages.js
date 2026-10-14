const { sanitizeDisplayName, createNameRegistry } = require("./names");
const { currentTime, sessionState } = require("./state");

function createMessageHandler({ state, transport, media }) {
  const { send, broadcast } = transport;
  const { isDisplayNameTaken } = createNameRegistry(state.clients);

  function updatePresence() {
    broadcast({ type: "presence", count: state.clients.size });
  }

  function handleMessage(ws, message) {
    const client = state.clients.get(ws.clientId);
    if (!client) return;
    switch (message.type) {
      case "join":
        {
          const requestedName = sanitizeDisplayName(message.name, client.name);
          const nameRejected = isDisplayNameTaken(requestedName, ws.clientId);
          if (!nameRejected) client.name = requestedName;
          if (!state.hostId) { state.hostId = ws.clientId; client.role = "host"; }
          send(ws, {
            type: "role", role: client.role, hostId: state.hostId, clientId: ws.clientId,
            viewerCount: state.clients.size, name: client.name,
            ...(nameRejected ? { nameRejected: requestedName } : {})
          });
          send(ws, sessionState(state, "join"));
          updatePresence();
        }
        break;
      case "set-name": {
        const requestedName = sanitizeDisplayName(message.name, client.name);
        if (isDisplayNameTaken(requestedName, ws.clientId)) {
          send(ws, {
            type: "name-rejected", name: client.name, requested: requestedName,
            message: `The display name “${requestedName}” is already in use.`
          });
          break;
        }
        client.name = requestedName;
        send(ws, { type: "name-updated", name: client.name });
        break;
      }
      case "chat": {
        const text = String(message.message || "").trim().slice(0, 300);
        if (!text) return;
        broadcast({ type: "chat", clientId: ws.clientId, name: client.name || "Guest", message: text,
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
        break;
      }
      case "video-state": {
        const syncMode = String(message.syncMode || "tick");
        if (!state.mediaPath || !state.mediaReady) return;
        const viewerPlayPause = client.role === "viewer" && (syncMode === "play" || syncMode === "pause");
        if (client.role !== "host" && !viewerPlayPause) return;
        const wasPaused = state.playback.paused;
        if (viewerPlayPause) {
          const sharedTime = currentTime(state);
          const reportedTime = Math.min(state.mediaDuration, Math.max(0, Number(message.time) || 0));
          const acceptedTime = Math.abs(reportedTime - sharedTime) <= 2 ? reportedTime : sharedTime;
          state.playback = {
            paused: syncMode === "pause",
            time: acceptedTime,
            rate: state.playback.rate,
            updatedAt: Date.now()
          };
        } else {
          state.playback = {
            paused: Boolean(message.paused),
            time: Math.min(state.mediaDuration, Math.max(0, Number(message.time) || 0)),
            rate: Math.min(4, Math.max(0.25, Number(message.playbackRate) || 1)),
            updatedAt: Date.now()
          };
        }
        if ((!wasPaused && state.playback.paused) || syncMode === "seek") media.cancelSegmentJobs(false);
        // Echo viewer play/pause back to its sender so its local shared-state
        // flag is updated too. Host-originated state already matches locally.
        broadcast(sessionState(state, syncMode), viewerPlayPause ? null : ws.clientId);
        break;
      }
    }
  }

  return { handleMessage, updatePresence };
}

module.exports = { createMessageHandler };
