const test = require('node:test');
const assert = require('node:assert/strict');
const { createApplication } = require('../server/application');
const { CPU_ENCODER } = require('../server/encoders');
const { connectPeer } = require('./helpers/peer');
const { createConfig } = require('../server/config');

async function setup(t, config = {}) {
  const app = createApplication({ config: { port: 0, hostReconnectGraceMs: 0, rtcIceServers: [], ...config }, encoderPromise: Promise.resolve(CPU_ENCODER) });
  const address = await app.listen(); t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  const host = await connectPeer(base.replace('http', 'ws'), 'Sharer');
  return { app, base, host, viewer: () => connectPeer(base.replace('http', 'ws'), 'Viewer') };
}
async function start(peer, requestId = 'start1') {
  peer.send({ type: 'screen-share-start', surface: 'browser', audio: true, requestId });
  return peer.next('screen-share-started', m => m.requestId === requestId);
}

test('screen sharing enforces selection permissions and preserves the source until a valid replacement', async t => {
  const { app, base, host, viewer } = await setup(t); const guest = await viewer();
  guest.send({ type: 'screen-share-start', requestId: 'denied', surface: 'monitor', audio: false });
  assert.match((await guest.next('error', m => m.requestId === 'denied')).message, /not allowed/);
  const shared = await start(host);
  const snapshot = await guest.next('session-state', m => m.sourceId === shared.sourceId);
  assert.equal(snapshot.sourceType, 'screen'); assert.equal(snapshot.hasVideo, true);
  assert.equal(snapshot.sourceOwnerId, host.role.clientId); assert.equal(snapshot.originalUrl, null);
  assert.equal(snapshot.screenShare.audio, true); assert.deepEqual(snapshot.screenShare.iceServers, []);
  const directory = await (await fetch(base + '/api/rooms')).json();
  assert.equal(directory.rooms.find(room => room.id === 'default').fileName, 'Shared tab');
  guest.send({ type: 'screen-share-stop', sourceId: shared.sourceId, requestId: 'stop-denied' });
  assert.match((await guest.next('error', m => m.requestId === 'stop-denied')).message, /sharer or host/);
  host.send({ type: 'source-register', requestId: 'invalid-file', video: { id: 'f', name: 'clip.mp4', size: 0 } });
  await host.next('error', m => m.requestId === 'invalid-file');
  assert.equal(app.state.sourceId, shared.sourceId);
  host.send({ type: 'source-register', requestId: 'valid-file', video: { id: 'f', name: 'clip.mp4', size: 32 } });
  await host.next('source-registered', m => m.requestId === 'valid-file');
  await guest.next('screen-share-ended', m => m.sourceId === shared.sourceId);
  assert.equal((await guest.next('session-state', m => m.mediaVersion > snapshot.mediaVersion && !m.hasVideo)).sourceType, null);
});

test('late viewers exchange only authorized, generation-bound screen signals within their room', async t => {
  const { base, host, viewer } = await setup(t); const live = await start(host);
  const guest = await viewer();
  assert.equal((await guest.next('session-state', m => m.sourceType === 'screen')).sourceId, live.sourceId);
  guest.send({ type: 'screen-share-watch', sourceId: live.sourceId, connectionId: 'peer1' });
  assert.equal((await host.next('screen-share-viewer')).clientId, guest.role.clientId);
  host.send({ type: 'screen-share-signal', sourceId: live.sourceId, connectionId: 'peer1', targetId: guest.role.clientId, description: { type: 'offer', sdp: 'v=0\r\n' } });
  assert.equal((await guest.next('screen-share-signal')).description.type, 'offer');
  guest.send({ type: 'screen-share-signal', sourceId: live.sourceId, connectionId: 'peer1', targetId: host.role.clientId, candidate: { candidate: 'candidate:example', sdpMid: '0', sdpMLineIndex: 0, unwanted: 'discard' } });
  const forwarded = await host.next('screen-share-signal');
  assert.equal(forwarded.candidate.candidate, 'candidate:example'); assert.equal(forwarded.candidate.unwanted, undefined);
  guest.send({ type: 'screen-share-signal', sourceId: live.sourceId, connectionId: 'peer1', targetId: host.role.clientId, description: { type: 'offer', sdp: 'v=0' } });
  assert.match((await guest.next('error', m => m.action === 'screen-share-signal')).message, /description/);
  const response = await fetch(base + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Other room' }) });
  const room = await response.json(), cookie = response.headers.get('set-cookie').split(';')[0];
  const outsider = await connectPeer(base.replace('http', 'ws') + room.endpoints.websocket, 'Outsider', { headers: { Cookie: cookie } });
  host.send({ type: 'screen-share-signal', sourceId: live.sourceId, connectionId: 'peer1', targetId: outsider.role.clientId, candidate: null });
  assert.match((await host.next('error', m => m.action === 'screen-share-signal')).message, /not available/);
  assert.equal(outsider.messages.filter(m => m.type === 'screen-share-signal').length, 0);
  host.send({ type: 'screen-share-signal', sourceId: live.sourceId, connectionId: 'old-peer', targetId: guest.role.clientId, candidate: null });
  assert.match((await host.next('error', m => m.action === 'screen-share-signal')).message, /not available/);
  guest.ws.close(); assert.equal((await host.next('screen-share-peer-left')).clientId, guest.role.clientId);
});

test('a permitted viewer can supply screens after host transfer, and provider departure clears live media', async t => {
  const { app, host, viewer } = await setup(t); const guest = await viewer();
  host.send({ type: 'set-viewer-permissions', clientId: guest.role.clientId, permissions: { chooseVideo: true }, requestId: 'grant' });
  await guest.next('permissions-updated', m => m.clientId === guest.role.clientId);
  const live = await start(guest);
  assert.equal((await host.next('session-state', m => m.sourceId === live.sourceId)).sourceOwnerId, guest.role.clientId);
  host.send({ type: 'transfer-host', clientId: guest.role.clientId, requestId: 'transfer' });
  await host.next('participant-action-complete', m => m.requestId === 'transfer');
  assert.equal(app.state.sourceType, 'screen'); assert.equal(app.state.sourceId, live.sourceId);
  guest.send({ type: 'transfer-host', clientId: host.role.clientId, requestId: 'transfer-back' });
  await guest.next('participant-action-complete', m => m.requestId === 'transfer-back');
  assert.equal(app.state.clients.get(guest.role.clientId).role, 'viewer');
  assert.equal(app.state.sourceId, live.sourceId);
  guest.ws.close();
  await host.next('screen-share-ended', m => m.sourceId === live.sourceId);
  assert.equal((await host.next('session-state', m => !m.hasVideo && m.mediaVersion > 0)).sourceOwnerId, null);
});

test('WebRTC relay configuration validates ICE URLs, credentials, and peer limits', () => {
  assert.deepEqual(createConfig({ rtcIceServers: [{ urls: ['turns:relay.example:5349'], username: 'member', credential: 'secret' }] }).rtcIceServers[0].username, 'member');
  assert.throws(() => createConfig({ rtcIceServers: [{ urls: 'https://invalid.example' }] }), /ICE/);
  assert.throws(() => createConfig({ rtcMaxViewers: 0 }), /rtcMaxViewers/);
});
