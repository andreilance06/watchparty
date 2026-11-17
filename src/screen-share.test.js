import { afterEach, expect, it, vi } from 'vitest';
import { createScreenShare } from '../js/screen-share.js';

afterEach(() => vi.unstubAllGlobals());
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
class Track extends EventTarget {
  constructor(kind) { super(); this.kind = kind; this.id = kind; this.readyState = 'live'; this.stop = vi.fn(() => { this.readyState = 'ended'; }); }
  getSettings() { return { displaySurface: 'browser', ...this.settings }; }
  getCapabilities() { return this.capabilities || {}; }
}
class Stream {
  constructor(tracks = []) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
  addTrack(track) { this.tracks.push(track); }
}
class Peer {
  static instances = [];
  constructor(config) { this.config = config; this.candidates = []; Peer.instances.push(this); }
  close() { this.closed = true; }
  addTrack() { return {}; }
  async createOffer() { return { type: 'offer', sdp: 'v=0-offer' }; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0-answer' }; }
  async setLocalDescription(value) { this.localDescription = value; }
  async setRemoteDescription(value) { this.remoteDescription = value; }
  async addIceCandidate(value) { if (!this.remoteDescription) throw new Error('No description'); this.candidates.push(value); }
}
function setup(capture) {
  Peer.instances = [];
  vi.stubGlobal('RTCPeerConnection', Peer); vi.stubGlobal('MediaStream', Stream);
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: vi.fn(capture) } });
  let state = { connected: true, role: 'host' }, manager;
  const send = vi.fn(() => true), onStream = vi.fn(), onChange = vi.fn();
  manager = createScreenShare({ send, getState: () => state, getClientId: () => 'self', onStream, onChange });
  manager.handleMessage({ type: 'session-state', sourceId: 'old-file', sourceType: 'file' });
  return { manager, send, onStream, onChange, setState: value => { state = value; } };
}
const live = (owner = 'self') => ({ type: 'session-state', sourceType: 'screen', sourceId: 'live1', sourceOwnerId: owner, screenShare: { iceServers: [] } });
async function start(h, stream) {
  const pending = h.manager.start(); await flush();
  const command = h.send.mock.calls.find(([m]) => m.type === 'screen-share-start')[0];
  h.manager.handleMessage({ type: 'screen-share-started', requestId: command.requestId, sourceId: 'live1' });
  await pending; h.manager.handleMessage(live());
  expect(h.onStream).toHaveBeenLastCalledWith(stream, true);
}

it('keeps an existing file when the capture picker is cancelled', async () => {
  const h = setup(async () => { throw Object.assign(new Error('Cancelled'), { name: 'NotAllowedError' }); });
  await h.manager.start(); expect(h.send).not.toHaveBeenCalled();
  expect(h.onChange).toHaveBeenLastCalledWith({ pending: false }); h.manager.destroy();
});

it('stops captured tracks when permission changes while the picker is open', async () => {
  let resolve; const stream = new Stream([new Track('video'), new Track('audio')]);
  const h = setup(() => new Promise(done => { resolve = done; }));
  const pending = h.manager.start(); h.setState({ connected: true, role: 'viewer', permissions: { chooseVideo: false } });
  resolve(stream); await pending;
  expect(h.send).not.toHaveBeenCalled(); stream.getTracks().forEach(track => expect(track.stop).toHaveBeenCalled()); h.manager.destroy();
});

it('negotiates late viewers and stops local tracks and peers when browser capture ends', async () => {
  const stream = new Stream([new Track('video'), new Track('audio')]); const h = setup(async () => stream);
  await start(h, stream);
  h.manager.handleMessage({ type: 'screen-share-viewer', sourceId: 'live1', clientId: 'viewer', connectionId: 'peer1' }); await flush();
  expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'screen-share-signal', targetId: 'viewer', description: { type: 'offer', sdp: 'v=0-offer' } }));
  stream.getVideoTracks()[0].dispatchEvent(new Event('ended'));
  stream.getTracks().forEach(track => expect(track.stop).toHaveBeenCalled()); expect(Peer.instances[0].closed).toBe(true);
  expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'screen-share-stop', sourceId: 'live1' })); h.manager.destroy();
});

it('queues ICE until the offer arrives and ignores obsolete connection generations', async () => {
  const h = setup(); h.manager.handleMessage(live('owner'));
  const watch = h.send.mock.calls.find(([m]) => m.type === 'screen-share-watch')[0];
  const signal = { type: 'screen-share-signal', sourceId: 'live1', clientId: 'owner', connectionId: watch.connectionId };
  h.manager.handleMessage({ ...signal, candidate: { candidate: 'candidate1' } });
  h.manager.handleMessage({ ...signal, description: { type: 'offer', sdp: 'v=0-offer' } }); await flush();
  expect(Peer.instances[0].candidates).toEqual([{ candidate: 'candidate1' }]);
  expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ description: { type: 'answer', sdp: 'v=0-answer' } }));
  h.manager.handleMessage({ ...signal, connectionId: 'obsolete', candidate: { candidate: 'ignored' } }); await flush();
  expect(Peer.instances[0].candidates).toHaveLength(1);
  h.manager.handleMessage({ type: 'session-state', sourceId: 'replacement', sourceType: 'file' });
  expect(Peer.instances[0].closed).toBe(true); h.manager.destroy();
});

it('retires a capture that ends while its registration acknowledgment is pending', async () => {
  const stream = new Stream([new Track('video')]), h = setup(async () => stream);
  const pending = h.manager.start(); await flush();
  const command = h.send.mock.calls.find(([m]) => m.type === 'screen-share-start')[0];
  stream.getVideoTracks()[0].readyState = 'ended';
  h.manager.handleMessage({ type: 'screen-share-started', requestId: command.requestId, sourceId: 'live1' }); await pending;
  expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'screen-share-stop', sourceId: 'live1' }));
  expect(h.onChange).not.toHaveBeenCalledWith(expect.objectContaining({ local: true })); h.manager.destroy();
});

it('retries a failed receiver with a fresh connection and ignores stale errors after replacement', () => {
  const h = setup(); h.manager.handleMessage(live('owner'));
  const first = h.send.mock.calls.find(([m]) => m.type === 'screen-share-watch')[0];
  const peer = Peer.instances[0]; peer.connectionState = 'failed'; peer.onconnectionstatechange();
  expect(peer.closed).toBe(true); expect(h.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ error: expect.stringContaining('Could not connect') }));
  h.manager.retry();
  const watches = h.send.mock.calls.map(([m]) => m).filter(m => m.type === 'screen-share-watch');
  expect(watches).toHaveLength(2); expect(watches[1].connectionId).not.toBe(first.connectionId);
  expect(h.onStream).toHaveBeenLastCalledWith(null, false);
  h.manager.handleMessage({ type: 'session-state', sourceType: 'file', sourceId: 'new' });
  h.onChange.mockClear();
  expect(h.manager.handleMessage({ type: 'error', action: 'screen-share-signal', sourceId: 'live1', message: 'Stale signal' })).toBe(true);
  expect(h.onChange).not.toHaveBeenCalled(); h.manager.destroy();
});

it('applies capture resolution and frame rate to the existing shared track for current and late viewers', async () => {
  const track = new Track('video');
  track.settings = { width: 1920, height: 1080, frameRate: 30 };
  track.capabilities = { width: { max: 3840 }, height: { max: 2160 }, frameRate: { max: 60 } };
  track.applyConstraints = vi.fn(async constraints => { track.settings = { width: constraints.width?.max || 3840, height: constraints.height?.max || 2160, frameRate: constraints.frameRate.max }; });
  const stream = new Stream([track, new Track('audio')]), h = setup(async () => stream);
  await start(h, stream);
  h.manager.handleMessage({ type: 'screen-share-viewer', sourceId: 'live1', clientId: 'viewer', connectionId: 'peer1' }); await flush();
  const count = h.send.mock.calls.length;
  expect(await h.manager.setQuality({ resolution: '720', frameRate: 60 })).toBe(true);
  expect(track.applyConstraints).toHaveBeenLastCalledWith({ width: { max: 1280 }, height: { max: 720 }, frameRate: { ideal: 60, max: 60 } });
  expect(h.onChange).toHaveBeenLastCalledWith({ quality: expect.objectContaining({ resolution: '720', frameRate: 60, actual: expect.objectContaining({ width: 1280, height: 720 }), pending: false }) });
  expect(h.send).toHaveBeenCalledTimes(count); expect(Peer.instances[0].closed).not.toBe(true); expect(track.stop).not.toHaveBeenCalled();
  expect(await h.manager.setQuality({ resolution: 'source', frameRate: 30 })).toBe(true);
  expect(track.applyConstraints).toHaveBeenLastCalledWith({ frameRate: { ideal: 30, max: 30 } });
  h.manager.destroy();
});

it('rejects invalid or unsupported settings, preserves quality on failure, and ignores stale constraint completions', async () => {
  const track = new Track('video'); track.settings = { width: 1920, height: 1080, frameRate: 30 };
  track.applyConstraints = vi.fn(async () => { throw new Error('OverconstrainedError'); });
  const stream = new Stream([track]), h = setup(async () => stream); await start(h, stream);
  expect(await h.manager.setQuality({ resolution: '9000', frameRate: 60 })).toBe(false); expect(track.applyConstraints).not.toHaveBeenCalled();
  expect(await h.manager.setQuality({ resolution: '720', frameRate: 30 })).toBe(false);
  expect(h.onChange).toHaveBeenLastCalledWith({ quality: expect.objectContaining({ resolution: '1080', pending: false, error: expect.stringContaining('Could not apply') }) });
  let finish; track.applyConstraints.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = h.manager.setQuality({ resolution: '720', frameRate: 30 });
  expect(await h.manager.setQuality({ resolution: '480', frameRate: 15 })).toBe(false);
  h.manager.stop(); h.onChange.mockClear(); finish(); expect(await pending).toBe(false); expect(h.onChange).not.toHaveBeenCalled();
  expect(await h.manager.setQuality({ resolution: '720' })).toBe(false); h.manager.destroy();
});

it('bounds choices to capture capabilities and retains portrait orientation', async () => {
  const track = new Track('video'); track.settings = { width: 720, height: 1280, frameRate: 24 };
  track.capabilities = { width: { max: 720 }, height: { max: 1280 }, frameRate: { max: 24 } };
  track.applyConstraints = vi.fn(async () => {});
  const stream = new Stream([track]), h = setup(async () => stream); await start(h, stream);
  expect(h.onChange).toHaveBeenCalledWith(expect.objectContaining({ quality: expect.objectContaining({ resolutions: ['source', '360', '480', '720'], frameRates: [15, 24], resolution: 'source', frameRate: 24 }) }));
  expect(await h.manager.setQuality({ resolution: '480', frameRate: 15 })).toBe(true);
  expect(track.applyConstraints).toHaveBeenCalledWith({ width: { max: 480 }, height: { max: 853 }, frameRate: { ideal: 15, max: 15 } });
  h.manager.destroy();
});
