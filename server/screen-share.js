const { randomUUID } = require('node:crypto');
const { can } = require('./permissions');
const { sessionState } = require('./state');

// Media travels directly between browsers. Only authenticated, room-scoped signaling passes here.
function createScreenShare(room, config) {
  const { state, transport } = room;
  let active = null, publish = () => {};
  const id = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(value);
  function reset() {
    if (!active) return;
    const previous = active; active = null;
    transport.broadcast({ type: 'screen-share-ended', sourceId: previous.id });
  }
  function stop() {
    reset(); room.media.reset();
    transport.broadcast(sessionState(state, 'source')); publish();
  }
  function handle(ws, message) {
    if (!['screen-share-start', 'screen-share-stop', 'screen-share-watch', 'screen-share-signal'].includes(message.type)) return false;
    const client = state.clients.get(ws.clientId);
    if (client?.ws !== ws || ws.readyState !== 1 || ws.explicitLeave) return true;
    const fail = text => transport.send(ws, { type: 'error', action: message.type, requestId: message.requestId, ...(id(message.sourceId) ? { sourceId: message.sourceId } : {}), message: text });
    const now = Date.now();
    if (!client.screenRate || now - client.screenRate.at >= 1000) client.screenRate = { at: now, count: 0 };
    if (++client.screenRate.count > 200) { if (client.screenRate.count === 201) fail('Too many screen-sharing requests. Try again shortly.'); return true; }
    try {
      if (message.type === 'screen-share-start') {
        if (!can(state, ws.clientId, 'chooseVideo')) throw new Error('The host has not allowed you to share a screen.');
        if (!id(message.requestId) || typeof message.audio !== 'boolean' || !['browser', 'window', 'monitor'].includes(message.surface)) throw new Error('Invalid screen-sharing request.');
        room.source.reset(); reset(); room.media.reset();
        active = { id: randomUUID(), owner: ws, viewers: new Map() };
        state.sourceType = 'screen'; state.sourceId = active.id; state.sourceOwnerId = ws.clientId;
        state.mediaVersion++; state.mediaReady = true;
        state.fileName = message.surface === 'browser' ? 'Shared tab' : message.surface === 'window' ? 'Shared window' : 'Shared screen';
        state.screenShare = { audio: message.audio, iceServers: config.rtcIceServers };
        state.playback.paused = false;
        transport.send(ws, { type: 'screen-share-started', requestId: message.requestId, sourceId: active.id, iceServers: config.rtcIceServers });
        transport.broadcast(sessionState(state, 'source')); publish(); return true;
      }
      if (!active || message.sourceId !== active.id) throw new Error('That screen share is no longer active.');
      if (message.type === 'screen-share-stop') {
        if (active.owner !== ws && state.hostId !== ws.clientId) throw new Error('Only the sharer or host can stop this screen share.');
        stop(); transport.send(ws, { type: 'screen-share-stopped', requestId: message.requestId }); return true;
      }
      if (!id(message.connectionId)) throw new Error('Invalid screen-sharing connection.');
      if (message.type === 'screen-share-watch') {
        if (ws === active.owner) throw new Error('The sharer already has a local preview.');
        if (!active.viewers.has(ws.clientId) && active.viewers.size >= config.rtcMaxViewers) throw new Error('This screen share has reached its viewer limit.');
        const previous = active.viewers.get(ws.clientId);
        if (previous && now - previous.at < 1000) return true;
        active.viewers.set(ws.clientId, { id: message.connectionId, at: now });
        transport.send(active.owner, { type: 'screen-share-viewer', sourceId: active.id, connectionId: message.connectionId, clientId: ws.clientId }); return true;
      }
      const target = state.clients.get(message.targetId);
      const ownerSending = ws === active.owner;
      const viewerId = ownerSending ? message.targetId : ws.clientId;
      if (!target || target.ws.readyState !== 1 || message.targetId === ws.clientId ||
          (!ownerSending && target.ws !== active.owner) || active.viewers.get(viewerId)?.id !== message.connectionId) throw new Error('That screen-sharing peer is not available in this room.');
      let payload;
      if (message.description) {
        const { type, sdp } = message.description;
        if (type !== (ownerSending ? 'offer' : 'answer') || typeof sdp !== 'string' || !sdp.length || sdp.length > 14000) throw new Error('Invalid screen-sharing description.');
        payload = { description: { type, sdp } };
      } else if (Object.hasOwn(message, 'candidate')) {
        const c = message.candidate;
        if (c !== null && (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.candidate !== 'string' || c.candidate.length > 2048 ||
          c.sdpMid != null && (typeof c.sdpMid !== 'string' || c.sdpMid.length > 256) ||
          c.sdpMLineIndex != null && (!Number.isInteger(c.sdpMLineIndex) || c.sdpMLineIndex < 0 || c.sdpMLineIndex > 32) ||
          c.usernameFragment != null && (typeof c.usernameFragment !== 'string' || c.usernameFragment.length > 256))) throw new Error('Invalid screen-sharing candidate.');
        payload = { candidate: c === null ? null : { candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null, ...(c.usernameFragment ? { usernameFragment: c.usernameFragment } : {}) } };
      } else throw new Error('Invalid screen-sharing signal.');
      transport.send(target.ws, { type: 'screen-share-signal', sourceId: active.id, connectionId: message.connectionId, clientId: ws.clientId, ...payload });
    } catch (error) { fail(error.message); }
    return true;
  }
  function disconnect(ws) {
    if (!active) return;
    if (active.owner === ws) { stop(); return; }
    if (active.viewers.delete(ws.clientId)) transport.send(active.owner, { type: 'screen-share-peer-left', sourceId: active.id, clientId: ws.clientId });
  }
  return { handle, reset, disconnect, setPublish(fn) { publish = fn; } };
}
module.exports = { createScreenShare };
