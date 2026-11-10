import { useCallback, useEffect, useRef, useState } from 'react';
import { createClientState } from '../js/state.js';
import { Dialog, Footer, Header, navigate, post, request, Status } from './shared.jsx';

export function RoomCard({ room, busy, onJoin }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [room.thumbnailUrl]);
  const preview = room.thumbnailUrl && !failed;
  return <article className="room-card overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
    <div className="room-preview">
      {preview && <img src={room.thumbnailUrl} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />}
      {!preview && <div className="room-placeholder"><span className="room-placeholder-icon">▶</span><span>{room.fileName ? 'Preview unavailable' : 'Waiting for a video'}</span></div>}
      <span className="room-badge">{room.passwordRequired ? 'Password protected' : room.id === 'default' ? 'Public room' : 'Open room'}</span>
    </div>
    <div className="room-card-body"><h3>{room.name}</h3><p className="room-file" title={room.fileName || 'No video selected'}>{room.fileName || 'No video selected'}</p>
      <div className="room-card-footer flex items-center justify-between gap-3"><span className="room-participants">{room.participantCount} online</span><button className="hub-button hub-primary" disabled={busy} aria-label={`Join ${room.name}`} onClick={() => onJoin(room)}>Join room</button></div>
    </div>
  </article>;
}

function EntryDialog({ mode, room, busy, error, onSubmit, onClose, expired }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const creating = mode === 'create';
  return <Dialog title={creating ? 'Start a watch party' : `Join ${room.name}`} onClose={onClose} busy={busy}>
    <form onSubmit={event => { event.preventDefault(); onSubmit({ name: name.trim(), password }); }}>
      <p className="eyebrow">{creating ? 'MAKE YOURSELF AT HOME' : 'YOUR SEAT IS WAITING'}</p>
      <h2>{creating ? 'Start a watch party' : `Join ${room.name}`}</h2>
      <p className="hub-dialog-description">{creating ? 'Make a room for your group. You choose what plays.' : 'This room needs a password. Ask the host if you don’t have it.'}</p>
      {creating && <label className="hub-field">Room name<input name="roomName" autoFocus required maxLength={80} placeholder="e.g. Friday night films" value={name} onChange={event => setName(event.target.value)} /></label>}
      <label className="hub-field">{creating ? 'Password (optional)' : 'Room password'}<input name="roomPassword" type="password" autoFocus={!creating} required={!creating} maxLength={128} autoComplete={creating ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)} /></label>
      {creating && <p className="hub-field-help">Leave it blank to let anyone join.</p>}
      <Status className="hub-form-status">{expired ? 'This room is no longer available.' : error || (busy ? 'Entering your room…' : '')}</Status>
      <div className="hub-dialog-actions"><button className="hub-button" type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="hub-button hub-primary" disabled={busy || expired}>{creating ? 'Create room' : 'Join room'}</button></div>
    </form>
  </Dialog>;
}

export function Hub() {
  const [identity] = useState(createClientState);
  const [name, setName] = useState(identity.clientName === identity.guestName ? '' : identity.clientName);
  const [rooms, setRooms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState(false);
  const [notice, setNotice] = useState(new URLSearchParams(location.search).has('blocked') ? 'You are blocked from that room until a host unblocks you.' : '');
  const [dialog, setDialog] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false), nameRef = useRef(name), handledInvite = useRef(false), identityRequest = useRef(null);
  const entryController = useRef(null);
  nameRef.current = name;
  useEffect(() => () => entryController.current?.abort(), []);
  const enter = useCallback(async (path, fields) => {
    const signal = entryController.current.signal;
    if (!identityRequest.current) identityRequest.current = post('/api/viewer-identity', undefined, signal).catch(error => { identityRequest.current = null; throw error; });
    await identityRequest.current;
    const displayName = nameRef.current.replace(/\s+/g, ' ').trim().slice(0, 24) || identity.guestName;
    const result = await post(path, { ...fields, displayName }, signal);
    if (typeof result.room?.watchPath !== 'string' || !/^\/watch(?:\?|$)/.test(result.room.watchPath)) throw new Error('The server returned an invalid room response.');
    try { localStorage.setItem('watchparty-display-name', displayName); } catch { /* Optional preference. */ }
    if (!signal.aborted) navigate(result.room.watchPath);
  }, [identity]);
  const choose = useCallback(async room => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setNotice(''); setError('');
    entryController.current = new AbortController();
    try {
      if (room.passwordRequired) {
        try {
          await request(`/rooms/${encodeURIComponent(room.id)}/api/session`, { signal: entryController.current.signal });
          navigate(room.watchPath);
        } catch (error) {
          if (error.status !== 401) throw error;
          setDialog({ mode: 'join', room });
        }
      } else await enter('/api/rooms/join', { roomId: room.id });
    } catch (error) { if (error.name !== 'AbortError') setNotice(error.message); }
    finally { busyRef.current = false; setBusy(false); }
  }, [enter]);
  const [refreshToken, setRefreshToken] = useState(0);
  useEffect(() => {
    let disposed = false, fetching = false, controller;
    async function refresh() {
      if (disposed || fetching || document.hidden) return;
      fetching = true; controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const result = await request('/api/rooms', { signal: controller.signal });
        if (!Array.isArray(result.rooms)) throw new Error('Invalid room directory.');
        if (disposed) return;
        setRooms(result.rooms); setFailure(false);
        const invitation = new URLSearchParams(location.search).get('room');
        if (invitation && !handledInvite.current) {
          handledInvite.current = true;
          const params = new URLSearchParams(location.search); params.delete('room');
          history.replaceState(null, '', params.size ? `/?${params}` : '/');
          const room = result.rooms.find(item => item.id === invitation);
          if (room) void choose(room); else setNotice('That room is no longer available. Choose another room or create your own.');
        }
      } catch { if (!disposed) setFailure(true); }
      finally { clearTimeout(timeout); fetching = false; if (!disposed) setLoading(false); }
    }
    const visible = () => { if (!document.hidden) void refresh(); };
    const restored = event => { if (event.persisted) location.reload(); };
    const timer = setInterval(refresh, 5000);
    document.addEventListener('visibilitychange', visible); window.addEventListener('pageshow', restored);
    void refresh();
    return () => { disposed = true; controller?.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('pageshow', restored); };
  }, [choose, refreshToken]);
  async function submit(fields) {
    if (busyRef.current) return;
    if (dialog.mode === 'create' && !fields.name) { setError('Enter a room name.'); return; }
    busyRef.current = true; setBusy(true); setError(''); entryController.current = new AbortController();
    try {
      await enter(dialog.mode === 'create' ? '/api/rooms' : '/api/rooms/join', { ...(dialog.mode === 'create' ? { name: fields.name } : { roomId: dialog.room.id }), ...(fields.password ? { password: fields.password } : {}) });
    } catch (error) { if (error.name !== 'AbortError') setError(error.message); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return <>
    <Header><button className="hub-button hub-primary" disabled={busy} onClick={() => { setError(''); setDialog({ mode: 'create' }); }}>＋ Create room</button></Header>
    <main className="hub-main mx-auto w-full max-w-[1280px] px-4 py-8 min-[700px]:px-8">
      <section className="hub-intro grid grid-cols-1 items-center gap-8 min-[900px]:grid-cols-[minmax(0,1fr)_340px]" aria-labelledby="hubTitle">
        <div className="hub-intro-copy"><p className="eyebrow">A GOOD TIME, TOGETHER</p><h2 id="hubTitle">Your people.<br />Your next watch.</h2><p>Find a room, say hello, and settle in together.</p></div>
        <div className="hub-join-profile"><h3>What should we call you?</h3><p>Choose your name, then join any room below.</p><label className="hub-name">Your name <span>(optional)</span><input name="displayName" maxLength={24} autoComplete="nickname" placeholder="Leave blank for a guest name" value={name} onChange={event => setName(event.target.value)} /></label><p className="hub-profile-hint">Just dropping in? We'll give you a guest name.</p></div>
      </section>
      <section aria-labelledby="roomsTitle"><div className="hub-section-heading"><div><h2 id="roomsTitle">Find your lounge <span className="hub-count">{rooms.length}</span></h2><p>A shared screen. A conversation. A good time.</p></div><span className="hub-live"><span aria-hidden="true" /> Updated live</span></div>
        {notice && <Status className="hub-notice">{notice}</Status>}
        <div className="hub-status-row"><Status className="hub-directory-status">{failure ? 'Could not refresh rooms. Check your connection and try again.' : loading ? 'Finding rooms…' : !rooms.length ? 'No rooms yet. Create a room to start watching.' : ''}</Status>{failure && <button className="hub-button" onClick={() => setRefreshToken(value => value + 1)}>Try again</button>}</div>
        <div className="room-grid grid grid-cols-1 gap-5 min-[700px]:grid-cols-2 min-[1100px]:grid-cols-3" aria-label="Available rooms" aria-busy={loading}>{rooms.map(room => <RoomCard key={room.id} room={room} busy={busy} onJoin={choose} />)}</div>
        <p className="hub-preview-note">Video previews refresh every 30 seconds. Room names and previews are visible to everyone.</p>
      </section>
    </main>
    {dialog && <EntryDialog {...dialog} busy={busy} error={error} expired={dialog.mode === 'join' && !rooms.some(room => room.id === dialog.room.id)} onSubmit={submit} onClose={() => { setDialog(null); setError(''); }} />}
    <Footer />
  </>;
}
