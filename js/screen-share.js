import { can } from './permissions.js';
import { createClientId } from './utils/client-id.js';
import { captureQuality, captureConstraints } from './screen-share-quality.js';

export function createScreenShare({ send, getState, getClientId, onStream, onChange }) {
  const peers = new Map(), requests = new Map();
  let session = null, local = null, pendingCapture = null, ownedId = null, epoch = 0, busy = false, destroyed = false, connectionTimer;
  const update = value => { if (!destroyed) onChange(value); };
  const self = () => getClientId();
  function request(payload) {
    const requestId = createClientId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { requests.delete(requestId); reject(new Error('Screen sharing did not respond. Try again.')); }, 15000);
      requests.set(requestId, { resolve, reject, timer });
      if (send({ ...payload, requestId }) === false) { clearTimeout(timer); requests.delete(requestId); reject(new Error('Reconnect before sharing your screen.')); }
    });
  }
  function closePeer(id) {
    const entry = peers.get(id); if (!entry) return;
    peers.delete(id); entry.pc.onicecandidate = entry.pc.ontrack = entry.pc.onconnectionstatechange = null; entry.pc.close();
  }
  function clearMedia() {
    clearTimeout(connectionTimer);
    for (const id of [...peers.keys()]) closePeer(id);
    if (local) { local.track.removeEventListener('ended', local.ended); local.stream.getTracks().forEach(track => track.stop()); local = null; }
    ownedId = null; onStream(null, false); update({ local: false, quality: null });
  }
  async function setQuality(value) {
    const capture = local, previous = capture?.quality;
    if (!capture || !previous.supported || previous.pending || capture.track.readyState === 'ended') return false;
    const resolution = String(value.resolution ?? previous.resolution), frameRate = Number(value.frameRate ?? previous.frameRate);
    if (!previous.resolutions.includes(resolution) || !previous.frameRates.includes(frameRate)) return false;
    capture.quality = { ...previous, pending: true, error: '' }; update({ quality: capture.quality });
    try {
      await capture.track.applyConstraints(captureConstraints({ resolution, frameRate }, previous.actual));
      if (local !== capture || destroyed) return false;
      capture.quality = { ...previous, resolution, frameRate, actual: capture.track.getSettings?.() || {}, pending: false, error: '' };
      update({ quality: capture.quality });
      return true;
    } catch {
      if (local !== capture || destroyed) return false;
      capture.quality = { ...previous, pending: false, error: 'Could not apply these settings. Your previous quality is still selected. Try a lower resolution or frame rate.' };
      update({ quality: capture.quality });
      return false;
    }
  }
  const current = entry => !destroyed && session?.sourceId === entry.sourceId && peers.get(entry.id) === entry;
  function signal(entry, payload) {
    if (current(entry)) send({ type: 'screen-share-signal', sourceId: entry.sourceId, connectionId: entry.connectionId, targetId: entry.id, ...payload });
  }
  function peer(id, connectionId, owner) {
    closePeer(id);
    const pc = new RTCPeerConnection({ iceServers: session.screenShare?.iceServers || [] });
    const entry = { pc, id, connectionId, sourceId: session.sourceId, candidates: [], chain: Promise.resolve() };
    peers.set(id, entry);
    pc.onicecandidate = event => signal(entry, { candidate: event.candidate?.toJSON?.() || event.candidate || null });
    pc.onconnectionstatechange = () => {
      if (!current(entry)) return;
      if (pc.connectionState === 'connected' && !owner) { clearTimeout(connectionTimer); update({ status: 'Live screen share', error: '' }); }
      if (pc.connectionState === 'failed') {
        closePeer(id);
        if (!owner) update({ status: '', error: 'Could not connect to the shared screen. Try again.' });
      }
    };
    if (owner) for (const track of local.stream.getTracks()) {
      const sender = pc.addTrack(track, local.stream);
      if (track.kind === 'video' && sender.getParameters && sender.setParameters) {
        const parameters = sender.getParameters(); parameters.encodings ||= [{}];
        if (!parameters.encodings.length) parameters.encodings.push({});
        parameters.encodings[0].maxBitrate = 3000000;
        sender.setParameters(parameters).catch(() => {});
      }
    }
    else pc.ontrack = event => {
      if (!current(entry)) return;
      if (!entry.stream) entry.stream = event.streams?.[0] || new MediaStream();
      if (!entry.stream.getTracks().some(track => track.id === event.track.id)) entry.stream.addTrack(event.track);
      onStream(entry.stream, false);
    };
    return entry;
  }
  async function offer(message) {
    if (!local || ownedId !== message.sourceId || session?.sourceOwnerId !== self()) return;
    let entry;
    try {
      entry = peer(message.clientId, message.connectionId, true);
      const description = await entry.pc.createOffer(); if (!current(entry)) return;
      await entry.pc.setLocalDescription(description); if (!current(entry)) return;
      signal(entry, { description: { type: entry.pc.localDescription.type, sdp: entry.pc.localDescription.sdp } });
    } catch { if (entry && current(entry)) closePeer(entry.id); }
  }
  function receiveSignal(message) {
    const entry = peers.get(message.clientId);
    if (!entry || !current(entry) || entry.connectionId !== message.connectionId) return;
    entry.chain = entry.chain.then(async () => {
      if (!current(entry)) return;
      if (message.description) {
        await entry.pc.setRemoteDescription(message.description); if (!current(entry)) return;
        for (const candidate of entry.candidates.splice(0)) { await entry.pc.addIceCandidate(candidate); if (!current(entry)) return; }
        if (message.description.type === 'offer') {
          const answer = await entry.pc.createAnswer(); if (!current(entry)) return;
          await entry.pc.setLocalDescription(answer); if (!current(entry)) return;
          signal(entry, { description: { type: entry.pc.localDescription.type, sdp: entry.pc.localDescription.sdp } });
        }
      } else if (Object.hasOwn(message, 'candidate')) {
        if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(message.candidate);
        else if (entry.candidates.length < 128) entry.candidates.push(message.candidate);
      }
    }).catch(() => {
      if (!current(entry)) return;
      closePeer(entry.id);
      if (!local) update({ error: 'Could not connect to the shared screen. Try again.', status: '' });
    });
  }
  function watch() {
    if (!session || session.sourceType !== 'screen' || session.sourceOwnerId === self()) return;
    if (typeof RTCPeerConnection === 'undefined') { update({ error: 'This browser cannot play screen shares. Try a current desktop browser.' }); return; }
    clearTimeout(connectionTimer);
    onStream(null, false);
    const connectionId = createClientId();
    try { peer(session.sourceOwnerId, connectionId, false); }
    catch { update({ error: 'This browser could not start the screen connection. Try again.' }); return; }
    update({ error: '', status: 'Connecting to screen share…' });
    send({ type: 'screen-share-watch', sourceId: session.sourceId, connectionId });
    connectionTimer = setTimeout(() => { if (session?.sourceType === 'screen' && !local) update({ error: 'Could not connect to the shared screen. Try again.', status: '' }); }, 20000);
  }
  function setSession(next) {
    const changed = session?.sourceId !== next.sourceId || session?.sourceType !== next.sourceType;
    session = next;
    if (!changed) return;
    if (next.sourceType !== 'screen' || !ownedId || ownedId !== next.sourceId) clearMedia();
    if (next.sourceType === 'screen') {
      if (next.sourceOwnerId !== self()) watch();
      else if (local) { onStream(local.stream, true); update({ local: true, status: 'Sharing live', error: '' }); }
    } else update({ status: '', error: '' });
  }
  function stop() {
    const sourceId = ownedId;
    clearMedia(); update({ status: '', error: '' });
    if (sourceId) send({ type: 'screen-share-stop', sourceId, requestId: createClientId() });
  }
  async function start() {
    if (busy || local || destroyed) return;
    if (!getState().connected || !can(getState(), 'chooseVideo')) { update({ error: 'Ask the host for permission to share your screen.' }); return; }
    if (!globalThis.navigator?.mediaDevices?.getDisplayMedia || typeof RTCPeerConnection === 'undefined') {
      update({ error: 'Screen sharing needs HTTPS (or localhost) and a browser that supports screen capture.' }); return;
    }
    busy = true; const token = ++epoch, previousSource = session?.sourceId;
    update({ pending: true, error: '', status: '' });
    let stream, ended;
    try {
      // Must run directly from the user's click, before any asynchronous signaling.
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: true, selfBrowserSurface: 'exclude', surfaceSwitching: 'include' });
      if (token !== epoch || destroyed) { stream.getTracks().forEach(track => track.stop()); return; }
      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState === 'ended') throw new Error('No screen was selected. Try again.');
      pendingCapture = stream;
      ended = () => { if (local?.stream === stream) stop(); };
      track.addEventListener('ended', ended);
      if (token !== epoch || destroyed || !getState().connected || !can(getState(), 'chooseVideo') || previousSource !== session?.sourceId) {
        stream.getTracks().forEach(item => item.stop()); return;
      }
      const surface = track.getSettings?.().displaySurface;
      const reply = await request({ type: 'screen-share-start', audio: stream.getAudioTracks().length > 0, surface: ['browser', 'window', 'monitor'].includes(surface) ? surface : 'monitor' });
      if (token !== epoch || destroyed || track.readyState === 'ended') {
        stream.getTracks().forEach(item => item.stop()); send({ type: 'screen-share-stop', sourceId: reply.sourceId, requestId: createClientId() }); return;
      }
      clearMedia(); ownedId = reply.sourceId; local = { stream, track, ended, quality: captureQuality(track) };
      onStream(stream, true); update({ local: true, status: 'Sharing live', error: '', quality: local.quality });
    } catch (error) {
      if (stream) { stream.getVideoTracks()[0]?.removeEventListener('ended', ended); stream.getTracks().forEach(track => track.stop()); }
      if (token === epoch && !destroyed && !['NotAllowedError', 'AbortError'].includes(error.name)) update({ error: error.message || 'Screen sharing could not start. Try again.' });
    } finally {
      if (token === epoch) { pendingCapture = null; busy = false; update({ pending: false }); }
    }
  }
  function handleMessage(message) {
    const pending = requests.get(message.requestId);
    if (pending) { clearTimeout(pending.timer); requests.delete(message.requestId); message.type === 'error' ? pending.reject(new Error(message.message)) : pending.resolve(message); return true; }
    if (message.type === 'session-state') { setSession(message); return false; }
    if (message.type === 'screen-share-ended') { if (message.sourceId === session?.sourceId || message.sourceId === ownedId) clearMedia(); return true; }
    if (message.type === 'error' && message.action?.startsWith('screen-share-')) {
      if (!message.sourceId || message.sourceId === session?.sourceId) update({ error: message.message });
      return true;
    }
    if (message.sourceId && message.sourceId !== session?.sourceId) return message.type.startsWith('screen-share-');
    if (message.type === 'screen-share-viewer') { void offer(message); return true; }
    if (message.type === 'screen-share-signal') { receiveSignal(message); return true; }
    if (message.type === 'screen-share-peer-left') { closePeer(message.clientId); return true; }
    return false;
  }
  function disconnect() {
    epoch++; busy = false;
    pendingCapture?.getTracks().forEach(track => track.stop()); pendingCapture = null;
    for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(new Error('The screen-sharing connection closed.')); } requests.clear();
    clearMedia(); session = null; update({ pending: false, status: '', error: '' });
  }
  return { start, stop, setQuality, retry: watch, handleMessage, disconnect, destroy() { disconnect(); destroyed = true; } };
}
