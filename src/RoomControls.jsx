import { useEffect, useRef, useState } from 'react';
import { can } from '../js/permissions.js';
import { Button, Dialog, DialogHeader, Field, Header, Input, Status, post, navigate } from './shared.jsx';
import { useCommand, useRoom } from './room.jsx';
import { RoomPermissions } from './Permissions.jsx';
import { Icon } from './Icons.jsx';

export function DisplayNameForm({ children }) {
  const { state, send } = useRoom();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(state.clientName), [status, setStatus] = useState('');
  const [invalid, setInvalid] = useState(false), [pending, setPending] = useState(false);
  const input = useRef(null), trigger = useRef(null), sending = useRef(false), restoreFocus = useRef(false);
  const allowed = can(state, 'changeName');
  useEffect(() => { if (!editing) setName(state.clientName); }, [state.clientName, editing]);
  useEffect(() => {
    if (editing) { input.current?.focus(); input.current?.select(); }
    else if (restoreFocus.current) { restoreFocus.current = false; trigger.current?.focus({ preventScroll: true }); }
  }, [editing]);
  useEffect(() => {
    if (!sending.current || !state.nameFeedback) return;
    sending.current = false; setPending(false);
    const failed = state.nameFeedback.type === 'name-rejected';
    setInvalid(failed); setStatus(state.nameFeedback.message || (failed ? 'That name is already in use. Choose another.' : 'Display name updated.'));
    if (failed) input.current?.focus();
    else { restoreFocus.current = true; setEditing(false); }
  }, [state.nameFeedback]);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => { sending.current = false; setPending(false); setInvalid(true); setStatus('The name update was not confirmed. Try again.'); input.current?.focus(); }, 10000);
    return () => clearTimeout(timer);
  }, [pending]);
  useEffect(() => {
    if (!state.connected && sending.current) { sending.current = false; setPending(false); setStatus('Reconnect before saving your name.'); }
  }, [state.connected]);
  useEffect(() => {
    const message = state.lastMessage;
    if (sending.current && message?.type === 'error' && message.action === 'set-name') { sending.current = false; setPending(false); setInvalid(true); setStatus(message.message); input.current?.focus(); }
    if (!allowed && sending.current) { sending.current = false; setPending(false); }
  }, [state.event, allowed]);
  const close = () => {
    if (sending.current) return;
    restoreFocus.current = true; setEditing(false); setStatus(''); setInvalid(false);
  };
  const restriction = !allowed ? 'The host has disabled display-name changes.' : '';
  return <div className="watch-identity">
    <div className="watch-identity-heading">
      <form className={'watch-name-editor' + (editing ? ' is-editing' : '')} aria-label="Display name" noValidate onKeyDown={event => {
        if (editing && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      }} onSubmit={event => {
        event.preventDefault(); if (!editing || sending.current || !allowed) return;
        const value = name.replace(/\s+/g, ' ').trim();
        if (!value) { setInvalid(true); setStatus('Enter a display name.'); input.current?.focus(); return; }
        if (value === state.clientName) { close(); return; }
        if (!state.connected || send({ type: 'set-name', name: value }) === false) { setStatus('Reconnect before saving your name.'); return; }
        sending.current = true; setPending(true); setInvalid(false); setStatus('');
      }}>
        {editing ? <><label className="sr-only" htmlFor="watchDisplayName">Your display name</label><Input id="watchDisplayName" ref={input} name="displayName" autoComplete="nickname" value={name} maxLength={24} required disabled={!allowed} readOnly={pending} aria-invalid={invalid || undefined} aria-describedby="watchNameStatus" onChange={event => { setName(event.target.value); setInvalid(false); setStatus(''); }} /></> : <h2>{state.clientName}</h2>}
        <Button ref={trigger} type={editing ? 'submit' : 'button'} variant="quiet" icon aria-label={editing ? (pending ? 'Saving display name' : 'Save display name') : 'Edit display name'} title={editing ? 'Save display name' : 'Edit display name'} pending={pending} disabled={!allowed || (editing && !state.connected)} aria-describedby={restriction ? 'watchNameRestriction' : undefined} onClick={event => {
          if (!editing) { event.preventDefault(); setName(state.clientName); setStatus(''); setInvalid(false); setEditing(true); }
        }}>{!pending && <Icon name={editing ? 'check' : 'edit'} />}</Button>
      </form>
      {children}
    </div>
    {restriction && <p id="watchNameRestriction" className="watch-name-restriction">{restriction}</p>}
    <Status id="watchNameStatus" tone={invalid ? 'error' : 'neutral'} className={editing ? 'watch-name-status' : 'sr-only'}>{editing ? status || (!state.connected ? 'Reconnect before saving your name.' : '') : status}</Status>
  </div>;
}

export function RoomName() {
  const { state } = useRoom();
  const [editing, setEditing] = useState(false), [name, setName] = useState(state.room.name), [error, setError] = useState('');
  const trigger = useRef(null), input = useRef(null), submitted = useRef(null), restoreFocus = useRef(false);
  const { execute, pending, result, status, setStatus } = useCommand();
  const allowed = state.role === 'host';
  useEffect(() => {
    if (editing) { input.current?.focus(); input.current?.select(); }
    else if (restoreFocus.current) { restoreFocus.current = false; trigger.current?.focus({ preventScroll: true }); }
  }, [editing]);
  useEffect(() => {
    if (submitted.current && result?.requestId === submitted.current) {
      submitted.current = null;
      if (result.type !== 'error') { restoreFocus.current = true; setEditing(false); }
      else input.current?.focus();
    }
  }, [result]);
  useEffect(() => { if (!allowed && editing) { setEditing(false); setError(''); setStatus(''); } }, [allowed, editing]);
  const close = () => {
    if (pending) return;
    restoreFocus.current = true; setEditing(false); setError(''); setStatus('');
  };
  const failed = Boolean(error || (result?.type === 'error' && status));
  const feedback = editing ? error || (!state.connected ? 'Reconnect before saving the room name.' : status) : status && result && result.type !== 'error' ? 'Room name updated.' : '';
  return <div className="watch-room-title-editor">
    <form className={'watch-room-name' + (editing ? ' is-editing' : '')} aria-label="Room name editor" noValidate onKeyDown={event => {
      if (editing && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    }} onSubmit={event => {
      event.preventDefault(); if (!editing || pending || !allowed) return;
      const value = name.replace(/\s+/g, ' ').trim();
      if (!value || value.length > 80) { setError('Enter a room name of at most 80 characters.'); input.current?.focus(); return; }
      if (value === state.room.name) { close(); return; }
      setError(''); submitted.current = execute({ type: 'set-room-name', name: value });
    }}>
      {editing ? <><label className="sr-only" htmlFor="watchRoomName">Room name</label><Input id="watchRoomName" ref={input} name="roomName" value={name} maxLength={80} required readOnly={Boolean(pending)} disabled={!allowed} aria-invalid={failed || undefined} aria-describedby="roomNameStatus" onChange={event => { setName(event.target.value); setError(''); setStatus(''); }} /></> : <h1>{state.room.name}</h1>}
      {allowed && <Button ref={trigger} type={editing ? 'submit' : 'button'} variant="quiet" icon aria-label={editing ? (pending ? 'Saving room name' : 'Save room name') : 'Edit room name'} title={editing ? 'Save room name' : 'Edit room name'} pending={Boolean(pending)} disabled={!state.connected} onClick={event => {
        if (!editing) { event.preventDefault(); setName(state.room.name); setError(''); setStatus(''); setEditing(true); }
      }}>{!pending && <Icon name={editing ? 'check' : 'edit'} />}</Button>}
    </form>
    <Status id="roomNameStatus" tone={editing && failed ? 'error' : 'neutral'} className={editing ? 'watch-room-name-status' : 'sr-only'}>{feedback}</Status>
  </div>;
}

export function RoomIdentity() {
  const { state } = useRoom();
  return <section className="watch-header-room" aria-label="Current room"><RoomName /><Status className="watch-connection"><span className={`status-dot ${state.connected ? 'online' : 'offline'}`} aria-hidden="true" />{state.connectionText}</Status></section>;
}

export function RoomHeader() {
  const { state, roomId, disconnect } = useRoom();
  const [confirming, setConfirming] = useState(false), [leaving, setLeaving] = useState(false), [error, setError] = useState('');
  const returnTarget = useRef(null), stay = useRef(null), pending = useRef(false), departureConfirmed = useRef(false);
  const providing = state.sourceOwnerId === state.clientId || state.people.some(person => person.clientId === state.clientId && person.suppliesVideo);
  const watching = providing || state.media?.hasVideo || state.media?.processing;
  const sharing = state.connected && providing;
  useEffect(() => {
    if (!sharing) return;
    const beforeUnload = event => {
      if (departureConfirmed.current) return;
      // Only ask here. Existing pagehide cleanup runs after the user actually leaves.
      event.preventDefault();
      event.returnValue = true; // Legacy browser support; the browser supplies the wording.
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [sharing]);
  const close = () => { if (!pending.current) { setConfirming(false); setError(''); } };
  async function leave() {
    if (pending.current) return;
    pending.current = true; setLeaving(true); setError('');
    try {
      if (roomId) {
        const result = await post(`/rooms/${encodeURIComponent(roomId)}/api/leave`);
        if (result.left !== true) throw new Error('Could not leave the room. Try again.');
      }
      // The in-app dialog already confirmed this departure; avoid a second native prompt.
      departureConfirmed.current = true;
      disconnect(); navigate('/');
    } catch (failure) { departureConfirmed.current = false; setError(failure.message || 'Could not leave the room. Try again.'); }
    finally { pending.current = false; setLeaving(false); }
  }
  const title = providing ? 'Stop sharing and leave?' : 'Leave watch party?';
  function requestLeave(event) {
    // Opening another tab does not leave this room or interrupt its video source.
    if (!watching || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); returnTarget.current = event.currentTarget;
    setError(''); setConfirming(true);
  }
  return <>
    <Header brandHeading={false} context={<RoomIdentity />} onBrandClick={requestLeave}><a className="room-exit-link" href="/" aria-label="Exit room" title="Exit room" onClick={requestLeave}><Icon name="leave" /><span>Exit room</span></a></Header>
    {confirming && <Dialog title={title} returnFocusRef={returnTarget} initialFocusRef={stay} busy={leaving} onClose={close} aria-describedby="leaveRoomDescription">
      <DialogHeader title={title} />
      <p id="leaveRoomDescription" className="ui-dialog-description">{providing ? 'This browser is sharing the video. Leaving will stop playback for everyone in the room.' : 'Leave this watch party and return to the room list?'}</p>
      {error && <Status tone="error">{error}</Status>}
      <div className="confirmation-actions"><Button ref={stay} disabled={leaving} onClick={close}>Stay in room</Button><Button variant="danger" pending={leaving} pendingLabel="Leaving…" onClick={leave}>{providing ? 'Stop sharing and leave' : 'Leave room'}</Button></div>
    </Dialog>}
  </>;
}

export function RoomActions() {
  const { state, roomId } = useRoom();
  const [inviteOpen, setInviteOpen] = useState(false), [permissions, setPermissions] = useState(false), [copyStatus, setCopyStatus] = useState('');
  const inviteTrigger = useRef(null), permissionsTrigger = useRef(null), link = useRef(null);
  const includesAccess = Boolean(state.room.inviteAccessPath);
  const invite = new URL(state.room.inviteAccessPath || state.room.invitePath || `/?room=${encodeURIComponent(roomId || 'default')}`, location.origin).href;
  const displayedInvite = includesAccess ? invite.replace(/(#invite=)[^&]*/, '$1••••••••') : invite;
  return <div className="watch-room-actions">
    <Button ref={inviteTrigger} variant="quiet" icon aria-label="Invite friends" title="Invite friends" onClick={() => { setCopyStatus(''); setInviteOpen(true); }}><Icon name="invite" /></Button>
    {state.role === 'host' && <Button ref={permissionsTrigger} variant="quiet" icon aria-label="Room permissions" title="Room permissions" disabled={!state.connected} onClick={() => setPermissions(true)}><Icon name="settings" /></Button>}
    {inviteOpen && <Dialog title="Invite friends" returnFocusRef={inviteTrigger} onClose={() => setInviteOpen(false)}>
      <DialogHeader title="Invite friends" onClose={() => setInviteOpen(false)} />
      <p className="ui-dialog-description">Share this link to bring friends straight to {state.room.name}.{includesAccess ? ' Room access is included, so friends will not need to enter the password. Only the private access key is masked below.' : state.room.passwordRequired ? ' Friends will need the room password.' : ''}</p>
      <Field label="Invitation link" ref={link} type="text" autoComplete="off" value={displayedInvite} readOnly onFocus={event => event.target.select()} onCopy={event => { if (includesAccess) { event.preventDefault(); event.clipboardData.setData('text/plain', invite); } }} />
      <div className="watch-invite-actions"><Button variant="primary" onClick={async () => { try { await navigator.clipboard.writeText(invite); setCopyStatus('Invitation link copied.'); } catch { link.current?.focus(); link.current?.select(); setCopyStatus('Copy the selected invitation link using your browser or keyboard.'); } }}>Copy invitation link</Button></div>
      <Status>{copyStatus}</Status>
    </Dialog>}
    {permissions && <RoomPermissions returnFocusRef={permissionsTrigger} onClose={() => setPermissions(false)} />}
  </div>;
}
