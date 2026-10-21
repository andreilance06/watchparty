const { permissionKey, permissionsFor, promoteHost, isRoomCreator, DEFAULT_PERMISSIONS } = require("./permissions");
const { currentTime, sessionState } = require("./state");

function hostStatus(state) {
  return {
    clientId: state.hostId,
    name: state.clients.get(state.hostId)?.name || state.hostName,
    status: state.hostReconnectUntil ? "reconnecting" : state.clients.has(state.hostId) ? "connected" : "vacant",
    reconnectUntil: state.hostReconnectUntil
  };
}

function createHosting(room, { config, scheduleExpiry }) {
  const { state, transport } = room;
  let timer, reservation, publish = () => {};

  function cancel() {
    clearTimeout(timer);
    timer = null; reservation = null;
    state.hostReconnectUntil = null;
  }

  function role(clientId) {
    const client = state.clients.get(clientId);
    if (client) transport.send(client.ws, { type: "role", clientId, hostId: state.hostId, role: client.role,
      name: client.name, viewerCount: state.clients.size, permissions: permissionsFor(state, client, clientId) });
  }

  function assign(clientId, { notifyClient = true, announce = true } = {}) {
    const client = state.clients.get(clientId);
    if (!client) return;
    const previousId = state.hostId;
    cancel();
    const demoted = [];
    for (const [id, other] of state.clients) {
      if (id !== clientId && other.role === "host") {
        other.role = "viewer";
        state.viewerPermissions.set(permissionKey(other, id), { ...DEFAULT_PERMISSIONS });
        demoted.push(id);
      }
    }
    promoteHost(state, clientId);
    state.hostIdentity = permissionKey(client, clientId);
    state.hostName = client.name;
    if (previousId && previousId !== clientId) {
      state.playback = { ...state.playback, time: currentTime(state), updatedAt: Date.now() };
      state.playbackRevision++;
    }
    for (const id of demoted) role(id);
    if (notifyClient) role(clientId);
    if (announce) {
      transport.broadcast(sessionState(state, "host-transfer"));
      publish();
    }
  }

  function isCreator(clientId) {
    return isRoomCreator(state, clientId);
  }

  function connect(clientId, member) {
    const client = state.clients.get(clientId);
    const identity = permissionKey(client, clientId);
    // An authenticated original membership can bind a browser cookie created after room creation.
    if (member?.id === state.creatorMemberId) state.creatorIdentity = identity;
    if (isCreator(clientId) || state.hostId === clientId || !state.hostId || reservation?.identity === identity) {
      const previousId = state.hostId;
      assign(clientId, { notifyClient: false, announce: false });
      if (previousId && previousId !== clientId) transport.broadcast(sessionState(state, "host-transfer"));
    }
  }

  function release(clientId) {
    if (state.hostId !== clientId) return;
    cancel();
    const next = [...state.clients].find(([id, client]) => id !== clientId && client.ws.readyState === 1);
    if (next) assign(next[0], { announce: false });
    else {
      const previous = state.clients.get(clientId);
      if (previous) previous.role = "viewer";
      state.hostId = null; state.hostIdentity = null; state.hostName = null;
    }
    transport.broadcast({ type: "host-left", preserveMedia: Boolean(state.mediaPath), hostId: state.hostId });
    transport.broadcast(sessionState(state, "host-transfer"));
    publish();
    scheduleExpiry(room);
  }

  function disconnect(clientId, client, explicit = false) {
    if (state.hostId !== clientId) return;
    if (explicit || config.hostReconnectGraceMs === 0) { release(clientId); return; }
    cancel();
    const token = reservation = { identity: permissionKey(client, clientId) };
    state.hostIdentity = token.identity;
    state.hostName = client.name;
    state.hostReconnectUntil = Date.now() + config.hostReconnectGraceMs;
    timer = setTimeout(() => {
      if (reservation === token && !state.shuttingDown && state.hostId === clientId) release(clientId);
    }, config.hostReconnectGraceMs);
    timer.unref?.();
    scheduleExpiry(room);
  }

  function leave(member) {
    if (state.hostId === member.id || !state.clients.has(state.hostId) &&
        member.permissionIdentity && member.permissionIdentity === state.hostIdentity) release(state.hostId);
  }

  return { assign, connect, disconnect, leave, release, cancel, isCreator, setPublish(fn) { publish = fn; } };
}

module.exports = { createHosting, hostStatus };
