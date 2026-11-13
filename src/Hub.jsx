import { useCallback, useEffect, useRef, useState } from 'react';
import { createClientState } from '../js/state.js';
import { Button, Dialog, DialogHeader, Field, Header, Input, navigate, post, request, Status } from './shared.jsx';
import { Icon } from './Icons.jsx';

export function RoomCard({ room, busy, joining = false, onJoin }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [room.thumbnailUrl]);
  const preview = room.thumbnailUrl && !failed;
  return <article className="room-card">
    <div className="room-preview">
      {preview && <img src={room.thumbnailUrl} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />}
      {!preview && <div className="room-placeholder"><span className="room-placeholder-icon"><Icon name="video" /></span><span>{room.fileName ? 'Preview unavailable' : 'Waiting for a video'}</span></div>}
      {room.passwordRequired && <span className="room-badge"><Icon name="lock" />Password protected</span>}
    </div>
    <div className="room-card-body"><h3>{room.name}</h3>{room.fileName && <p className="room-file">{room.fileName}</p>}
      <div className="room-card-footer"><span className="room-participants"><Icon name="people" /><span>{room.participantCount} online</span></span><Button disabled={busy} pending={joining} pendingLabel="Joining…" aria-label={joining ? `Joining ${room.name}` : `Join ${room.name}`} onClick={() => onJoin(room)}>Join room<Icon name="arrow" /></Button></div>
    </div>
  </article>;
}

function EntryDialog({ mode, room, busy, error, onSubmit, onClose, expired }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const creating = mode === 'create';
  const nameInput = useRef(null), passwordInput = useRef(null);
  const nameError = creating && error === 'Enter a room name.' ? error : '';
  useEffect(() => { if (nameError) nameInput.current?.focus(); }, [nameError]);
  return <Dialog title={creating ? 'Create room' : `Join ${room.name}`} initialFocusRef={creating ? nameInput : passwordInput} onClose={onClose} busy={busy}>
    <form onSubmit={event => { event.preventDefault(); onSubmit({ name: name.trim(), password }); }}>
      <DialogHeader title={creating ? 'Create room' : `Join ${room.name}`} />
      <p className="ui-dialog-description">{creating ? 'Choose a video from your device, then invite your friends.' : 'Enter the password from the host to join.'}</p>
      {creating && <Field label="Room name" name="roomName" ref={nameInput} required maxLength={80} placeholder="e.g. Friday night films" value={name} onChange={event => setName(event.target.value)} error={nameError} />}
      <Field label={creating ? 'Password' : 'Room password'} ref={passwordInput} optional={creating} name="roomPassword" type="password" required={!creating} maxLength={128} autoComplete={creating ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)} aria-describedby={!creating ? 'hubEntryStatus' : undefined} aria-invalid={!creating && Boolean(error) || undefined} hint={creating ? 'Leave blank for an open room. Room names and previews are public, even with a password.' : undefined} />
      <Status id="hubEntryStatus" className="hub-form-status" tone={expired || error && !nameError ? 'error' : 'neutral'}>{expired ? 'This room is no longer available.' : nameError ? '' : error || (busy ? 'Entering your room…' : '')}</Status>
      <div className="hub-dialog-actions"><Button disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" pending={busy} pendingLabel={creating ? 'Creating…' : 'Joining…'} disabled={expired}>{creating ? 'Create room' : 'Join room'}</Button></div>
    </form>
  </Dialog>;
}

function HubIdentity({ name, onSave, disabled }) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(name);
  const trigger = useRef(null), input = useRef(null);
  return <>
    <Button ref={trigger} variant="quiet" className="hub-profile-trigger" aria-label={`Edit display name, currently ${name || 'Guest'}`} title="Edit display name" disabled={disabled} onClick={() => { setDraft(name); setEditing(true); }}><span className="hub-profile-name">{name || 'Guest'}</span><Icon name="edit" /></Button>
    {editing && <Dialog title="Edit display name" initialFocusRef={input} returnFocusRef={trigger} onClose={() => setEditing(false)}>
      <DialogHeader title="Edit display name" />
      <form onSubmit={event => { event.preventDefault(); onSave(draft.replace(/\s+/g, ' ').trim()); setEditing(false); }}>
        <Field label="Your name" optional ref={input} value={draft} maxLength={24} autoComplete="nickname" onChange={event => setDraft(event.target.value)} hint="Leave blank to join with a guest name." />
        <div className="hub-dialog-actions"><Button onClick={() => setEditing(false)}>Cancel</Button><Button type="submit" variant="primary">Save name</Button></div>
      </form>
    </Dialog>}
  </>;
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
  const [joiningRoom, setJoiningRoom] = useState(null);
  const [query, setQuery] = useState('');
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
    busyRef.current = true; setBusy(true); setJoiningRoom(room.id); setNotice(''); setError('');
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
    finally { busyRef.current = false; setBusy(false); setJoiningRoom(null); }
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
  const visibleRooms = rooms.filter(room => `${room.name} ${room.fileName || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div className="hub-page">
    <a className="watch-skip" href="#hubMain">Skip to rooms</a>
    <Header brandHeading={false}><HubIdentity name={name} disabled={busy} onSave={value => { setName(value); try { localStorage.setItem('watchparty-display-name', value); } catch { /* Optional preference. */ } }} /></Header>
    <main id="hubMain" tabIndex={-1} className="hub-main">
      <section className="hub-intro" aria-labelledby="hubTitle">
        <div><h1 id="hubTitle">Watch together.</h1><p>Join a room or start one for your friends.</p></div>
        <Button variant="primary" disabled={busy} onClick={() => { setError(''); setDialog({ mode: 'create' }); }}><Icon name="plus" />Create room</Button>
      </section>
      <section aria-labelledby="roomsTitle"><div className="hub-section-heading"><h2 id="roomsTitle">Rooms <span className="hub-count" aria-hidden="true">{loading ? '…' : rooms.length}</span><span className="sr-only">{loading ? ', loading' : `, ${rooms.length} available`}</span></h2>
        <div className="hub-search"><Icon name="search" /><Input type="search" aria-label="Search rooms" placeholder="Search rooms or videos" value={query} onChange={event => setQuery(event.target.value)} /></div></div>
        {notice && <Status className="hub-notice" tone="warning">{notice}</Status>}
        {(failure || loading) && <div className="hub-status-row"><Status tone={failure ? 'error' : 'neutral'}>{failure ? 'Could not refresh rooms. Check your connection and try again.' : 'Finding rooms…'}</Status>{failure && <Button onClick={() => setRefreshToken(value => value + 1)}>Try again</Button>}</div>}
        <div className="room-grid" aria-label="Available rooms" aria-busy={loading}>
          {loading && !rooms.length ? Array.from({ length: 3 }, (_, index) => <div key={index} className="hub-skeleton" aria-hidden="true"><div /><span /><span /></div>) : visibleRooms.map(room => <RoomCard key={room.id} room={room} busy={busy} joining={joiningRoom === room.id} onJoin={choose} />)}
        </div>
        {!loading && !failure && !rooms.length && <div className="hub-empty"><Icon name="video" /><p>No rooms yet. Create a room to start watching.</p></div>}
        {!loading && rooms.length > 0 && !visibleRooms.length && <div className="hub-empty"><Icon name="search" /><p>No rooms match “{query.trim()}”.</p><Button onClick={() => setQuery('')}>Clear search</Button></div>}
        {query.trim() && <Status className="sr-only">{visibleRooms.length} matching {visibleRooms.length === 1 ? 'room' : 'rooms'}</Status>}
        <p className="hub-preview-note">Room names and previews are public, including password-protected rooms.</p>
      </section>
    </main>
    {dialog && <EntryDialog {...dialog} busy={busy} error={error} expired={dialog.mode === 'join' && !rooms.some(room => room.id === dialog.room.id)} onSubmit={submit} onClose={() => { setDialog(null); setError(''); }} />}
  </div>;
}
