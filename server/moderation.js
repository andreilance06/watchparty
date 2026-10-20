const { permissionKey, permissionsFor, promoteHost, DEFAULT_PERMISSIONS } = require("./permissions");
const { currentTime, sessionState } = require("./state");
const { participants } = require("./participants");

function createModeration(room, scheduleExpiry) {
  const { state, transport } = room;
  let publish = () => transport.broadcast({ type: "presence", count: state.clients.size, participants: participants(state) });
  const role = clientId => {
    const client = state.clients.get(clientId);
    if (client) transport.send(client.ws, { type: "role", clientId, hostId: state.hostId, role: client.role,
      name: client.name, viewerCount: state.clients.size, permissions: permissionsFor(state, client, clientId) });
  };
  function advanceClock() {
    state.playback = { ...state.playback, time: currentTime(state), updatedAt: Date.now() };
    state.playbackRevision++;
  }
  function handle(ws, message) {
    if (!["block-participant", "unblock-participant", "transfer-host"].includes(message.type)) return false;
    const reply = payload => transport.send(ws, { requestId: message.requestId, action: message.type, clientId: message.clientId, ...payload });
    try {
      const host = state.clients.get(ws.clientId);
      if (!host || host.ws !== ws || host.role !== "host" || state.hostId !== ws.clientId) throw new Error("Only the current host can manage participants.");
      if (typeof message.clientId !== "string" || typeof message.requestId !== "string" || !message.requestId || message.requestId.length > 100) throw new Error("Invalid participant request.");
      if (message.type === "unblock-participant") {
        const record = [...state.blockedParticipants].find(([, value]) => value.clientId === message.clientId);
        if (!record) throw new Error("That participant is no longer blocked.");
        state.blockedParticipants.delete(record[0]);
      } else {
        const target = state.clients.get(message.clientId);
        if (!target || target.role !== "viewer" || target.ws.readyState !== 1 || message.clientId === ws.clientId) throw new Error("Choose a connected viewer.");
        const key = permissionKey(target, message.clientId);
        if (message.type === "transfer-host") {
          host.role = "viewer";
          state.viewerPermissions.set(permissionKey(host, ws.clientId), { ...DEFAULT_PERMISSIONS });
          promoteHost(state, message.clientId);
          advanceClock();
          role(ws.clientId); role(message.clientId);
          transport.broadcast(sessionState(state, "host-transfer"));
        } else {
          if (key === permissionKey(host, ws.clientId)) throw new Error("You cannot block your own browser.");
          state.blockedParticipants.set(key, { clientId: message.clientId, name: target.name,
            permissions: { ...permissionsFor(state, target, message.clientId) } });
          for (const member of room.members.values()) {
            if ((member.permissionIdentity || `member:${member.id}`) === key) member.revoked = true;
          }
          for (const [clientId, client] of [...state.clients]) {
            if (permissionKey(client, clientId) !== key) continue;
            room.source.disconnectControl(client.ws);
            state.clients.delete(clientId); state.videoVotes.delete(clientId);
            transport.send(client.ws, { type: "room-blocked", message: "The host blocked you from this room. You can rejoin after a host unblocks you." });
            client.ws.close(4003, "Blocked from room");
          }
          for (const response of room.activeResponses.get(key) || []) response.destroy();
          room.activeResponses.delete(key);
          scheduleExpiry(room);
        }
      }
      publish();
      reply({ type: "participant-action-complete" });
    } catch (error) { reply({ type: "error", message: error.message }); }
    return true;
  }
  function releaseHost(clientId) {
    if (state.hostId !== clientId) return;
    state.hostId = null;
    const next = state.clients.keys().next().value;
    if (next) { promoteHost(state, next); advanceClock(); role(next); }
    transport.broadcast({ type: "host-left", preserveMedia: Boolean(state.mediaPath), hostId: state.hostId });
    transport.broadcast(sessionState(state, "host-transfer"));
    publish();
  }
  return { handle, releaseHost, publish: () => publish(), setPublish(fn) { publish = fn; } };
}

module.exports = { createModeration };
