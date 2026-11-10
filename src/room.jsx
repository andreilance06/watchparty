import { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState } from 'react';
import { createClientState } from '../js/state.js';
import { createConnection } from '../js/connection.js';
import { createClientId } from '../js/utils/client-id.js';
import { DEFAULT_PERMISSIONS } from '../js/permissions.js';
import { navigate, post, request } from './shared.jsx';

export const RoomContext = createContext(null);
export const useRoom = () => useContext(RoomContext);
export function initialRoom(identity) {
  return { ...identity, connected: false, connectionText: 'Connecting…', permissions: DEFAULT_PERMISSIONS,
    roomPermissions: DEFAULT_PERMISSIONS, room: { name: 'Default room', invitePath: '/?room=default' },
    people: [], viewerCount: 0, sourceOwnerId: null, poll: { id: null, status: 'idle' }, suggestions: [], myVoteId: null,
    messages: [{ id: 'welcome', system: true, message: 'Welcome to WatchParty.' }], reactions: [], responses: [], nameFeedback: null, lastMessage: null, event: 0 };
}
export function roomReducer(state, action) {
  if (action.type === 'status') return { ...state, connected: action.connected, connectionText: action.text };
  if (action.type === 'metadata') return { ...state, room: action.room };
  if (action.type === 'system') return { ...state, messages: [...state.messages, { id: action.id, system: true, message: action.message }].slice(-500) };
  if (action.type === 'expire-reactions') return { ...state, reactions: state.reactions.filter(item => item.expires > action.now) };
  const m = action.message;
  let next = { ...state, lastMessage: m, event: state.event + 1, ...(m.roomPermissions ? { roomPermissions: m.roomPermissions } : {}) };
  // Keep acknowledgments through batched renders, even if a presence update follows.
  if (m.requestId) next.responses = [...state.responses.filter(item => item.requestId !== m.requestId), m].slice(-64);
  const people = value => (value || []).map(person => ({ ...person, sameBrowser: person.sameBrowser ?? state.people.find(old => old.clientId === person.clientId)?.sameBrowser }));
  switch (m.type) {
    case 'role': next = { ...next, clientId: m.clientId, clientName: m.name || state.clientName, role: m.role, permissions: m.permissions || state.permissions, viewerCount: m.viewerCount }; break;
    case 'presence': next.people = people(m.participants); next.viewerCount = m.count; break;
    case 'party-state':
      next = { ...next, people: people(m.participants), poll: m.poll || state.poll, suggestions: m.suggestions || [], myVoteId: m.myVoteId ?? null, host: m.host };
      break;
    case 'session-state': if (m.sourceOwnerId !== undefined) next.sourceOwnerId = m.sourceOwnerId; break;
    case 'permissions-updated':
      next.people = state.people.map(person => person.clientId === m.clientId ? { ...person, permissions: m.permissions, permissionOverrides: m.permissionOverrides || {} } : person);
      if (m.clientId === state.clientId) next.permissions = m.permissions;
      break;
    case 'chat':
      if (!state.messages.some(item => item.commentId === m.commentId)) next.messages = [...state.messages, { ...m, id: m.commentId, reactions: [] }].slice(-500);
      break;
    case 'comment-reaction':
      next.messages = state.messages.map(item => item.commentId === m.commentId ? { ...item, reactions: m.reactions || [], myReaction: 'myReaction' in m ? m.myReaction : m.reactions?.find(item => item.clientId === state.clientId)?.emoji || null } : item);
      break;
    case 'reaction': next.reactions = [...state.reactions, { ...m, id: action.id, expires: action.now + 4000 }].slice(-5); break;
    case 'name-updated': case 'name-rejected': next.clientName = m.name; next.nameFeedback = m; break;
  }
  if (m.participants) {
    const current = m.participants.find(person => person.clientId === next.clientId);
    if (current?.permissions) next.permissions = current.permissions;
  }
  return next;
}

export function RoomProvider({ children }) {
  const [identity] = useState(createClientState);
  const [state, dispatch] = useReducer(roomReducer, identity, initialRoom);
  const session = useRef({ ...identity });
  const player = useRef(null), transport = useRef(null), attention = useRef(null);
  const stateRef = useRef(state); stateRef.current = state;
  const roomId = new URLSearchParams(location.search).get('roomId');
  const send = useCallback(payload => transport.current?.send(payload) ?? false, []);
  const system = useCallback(message => dispatch({ type: 'system', message, id: createClientId() }), []);
  const registerPlayer = useCallback(value => { player.current = value; }, []);
  useEffect(() => {
    let disposed = false, connection;
    const controller = new AbortController();
    function blocked() {
      connection?.dispose(); player.current?.files.disconnect();
      navigate('/?blocked=1');
    }
    function receive(message) {
      if (disposed) return;
      const media = player.current;
      const previous = stateRef.current;
      dispatch({ type: 'message', message, id: createClientId(), now: Date.now() });
      if (media?.files.handleMessage(message) || media?.controller.handleQuality(message)) return;
      switch (message.type) {
        case 'role':
          session.current.clientId = message.clientId;
          session.current.clientName = message.name || session.current.clientName;
          media?.controller.applyRole(message.role);
          media?.controller.applyPermissions(message.permissions);
          if (message.nameRejected) system(`“${message.nameRejected}” is already in use. You joined as ${message.name}.`);
          break;
        case 'presence': case 'party-state': {
          const current = message.participants?.find(person => person.clientId === session.current.clientId);
          if (current?.permissions) media?.controller.applyPermissions(current.permissions);
          if (message.poll?.status === 'closed' && message.poll.id !== previous.concludedPoll) {
            // The poll result is posted once per connection, including on initial join.
            if (concluded !== message.poll.id && message.poll.result) {
              concluded = message.poll.id;
              const result = message.poll.result;
              const winners = result.suggestions.filter(item => result.winnerIds.includes(item.id));
              system(`Movie poll concluded. ${!winners.length ? 'No votes cast.' : `${winners.length > 1 ? 'Tie' : 'Winner'}: ${winners.map(item => item.title).join(', ')} (${winners[0].votes} votes).`}`);
            }
          }
          break;
        }
        case 'session-state': media?.controller.applySessionState(message); break;
        case 'permissions-updated': if (message.clientId === session.current.clientId) media?.controller.applyPermissions(message.permissions); break;
        case 'playback-rejected': media?.controller.rejectPlayback(message); system(message.message); break;
        case 'captions-updated': media?.controller.updateCaptions(message); break;
        case 'compatibility-ready': media?.controller.applyCompatibility(message); break;
        case 'transcode-info': media?.controller.updateEncoder(message); break;
        case 'media-error': media?.controller.showMediaError(message.message); break;
        case 'host-left':
          if (!message.preserveMedia) media?.controller.showNoVideo('Host disconnected');
          system(message.hostId ? 'The host left. A new host has taken over.' : 'The host left. Waiting for a new host…'); break;
        case 'chat': if (message.clientId !== session.current.clientId) attention.current?.receiveMessage(message); break;
        case 'reaction': attention.current?.receiveReaction(message); break;
        case 'room-blocked': blocked(); break;
        case 'error': if (message.action !== 'chat') system(message.message); break;
      }
    }
    let concluded;
    async function start() {
      try {
        await post('/api/viewer-identity', undefined, controller.signal);
        let admission;
        try { admission = await request(roomId ? `/rooms/${encodeURIComponent(roomId)}/api/session` : '/api/session', { signal: controller.signal }); }
        catch (error) {
          if (error.code === 'ROOM_BLOCKED') { blocked(); return; }
          if ([401, 403, 404].includes(error.status)) { navigate(roomId ? `/?room=${encodeURIComponent(roomId)}` : '/'); return; }
          throw error;
        }
        if (disposed) return;
        dispatch({ type: 'metadata', room: admission.room || stateRef.current.room });
        connection = createConnection({ path: admission.endpoints?.websocket || '/ws',
          getIdentity: () => ({ clientId: session.current.clientId, name: session.current.clientName }),
          onMessage: receive, onBlocked: blocked,
          beforeReconnect: async () => {
            try { await request(roomId ? `/rooms/${encodeURIComponent(roomId)}/api/session` : '/api/session', { signal: controller.signal }); }
            catch (error) { if (error.code === 'ROOM_BLOCKED') { blocked(); return false; } throw error; }
          },
          onStatus: (connected, text) => {
            if (disposed) return;
            dispatch({ type: 'status', connected, text });
            if (!connected) { player.current?.files.disconnect(); player.current?.controller.disconnect(); }
          },
        });
        transport.current = connection; connection.connect();
      } catch (error) { if (!disposed) dispatch({ type: 'status', connected: false, text: `${error.message} Reload to reconnect.` }); }
    }
    void start();
    const timer = setInterval(() => dispatch({ type: 'expire-reactions', now: Date.now() }), 1000);
    const restore = event => { if (event.persisted) location.reload(); };
    const hide = () => { connection?.dispose(); player.current?.files.disconnect(); };
    window.addEventListener('pagehide', hide); window.addEventListener('pageshow', restore);
    return () => { disposed = true; controller.abort(); connection?.dispose(); transport.current = null; clearInterval(timer); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', restore); };
  }, [roomId, system]);
  useEffect(() => {
    session.current.clientName = state.clientName;
    try { localStorage.setItem('watchparty-display-name', state.clientName); } catch { /* Optional. */ }
  }, [state.clientName]);
  return <RoomContext.Provider value={{ state, session, send, system, roomId, player, registerPlayer, attention, disconnect: () => transport.current?.dispose() }}>{children}</RoomContext.Provider>;
}

// Commands are acknowledged by the existing requestId protocol, never optimistically committed.
export function useCommand() {
  const { state, send } = useRoom();
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(null);
  const pendingRef = useRef(null);
  useEffect(() => {
    const m = state.responses.find(item => item.requestId === pendingRef.current);
    if (pendingRef.current && m?.requestId === pendingRef.current) {
      pendingRef.current = null; setPending(null); setStatus(m.type === 'error' ? m.message : 'Updated.');
    }
  }, [state.event, state.lastMessage]);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => { pendingRef.current = null; setPending(null); setStatus('The request timed out. Try again.'); }, 10000);
    return () => clearTimeout(timer);
  }, [pending]);
  useEffect(() => { if (!state.connected && pendingRef.current) { pendingRef.current = null; setPending(null); setStatus('Reconnect before updating.'); } }, [state.connected]);
  const execute = payload => {
    if (pendingRef.current) return;
    const requestId = createClientId();
    if (!state.connected || send({ ...payload, requestId }) === false) { setStatus('Reconnect before updating.'); return; }
    pendingRef.current = requestId; setPending(requestId); setStatus('Updating…');
  };
  return { execute, pending, status, setStatus };
}
