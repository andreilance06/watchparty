import { useEffect, useRef, useState } from 'react';
import { can } from '../js/permissions.js';
import { Button, Dialog, DialogHeader, Field, post, navigate, Status } from './shared.jsx';
import { useCommand, useRoom } from './room.jsx';
import { RoomPermissions } from './Permissions.jsx';
import { Icon } from './Icons.jsx';

export function DisplayNameForm() {
  const { state, send } = useRoom();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(state.clientName), [status, setStatus] = useState('');
  const [invalid, setInvalid] = useState(false), [pending, setPending] = useState(false);
  const input = useRef(null), trigger = useRef(null), sending = useRef(false);
  const allowed = can(state, 'changeName');
  useEffect(() => setName(state.clientName), [state.clientName]);
  useEffect(() => {
    if (!sending.current || !state.nameFeedback) return;
    sending.current = false; setPending(false);
    const failed = state.nameFeedback.type === 'name-rejected';
    setInvalid(failed); setStatus(state.nameFeedback.message || (failed ? 'That name is already in use. Choose another.' : 'Display name updated.'));
    if (failed) input.current?.focus();
    else setEditing(false);
  }, [state.nameFeedback]);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => { sending.current = false; setPending(false); setStatus('The name update was not confirmed. Try again.'); }, 10000);
    return () => clearTimeout(timer);
  }, [pending]);
  useEffect(() => {
    if (!state.connected && sending.current) { sending.current = false; setPending(false); setStatus('Reconnect before saving your name.'); }
  }, [state.connected]);
  useEffect(() => {
    const message = state.lastMessage;
    if (sending.current && message?.type === 'error' && message.action === 'set-name') { sending.current = false; setPending(false); setStatus(message.message); }
    if (!allowed && sending.current) { sending.current = false; setPending(false); }
  }, [state.event, allowed]);
  const close = () => { if (!sending.current) { setEditing(false); setStatus(''); setInvalid(false); } };
  const restriction = !allowed ? 'The host has disabled display-name changes.' : '';
  return <div className="watch-identity">
    <div className="watch-identity-heading"><h2>{state.clientName}</h2><Button ref={trigger} variant="quiet" icon aria-label="Edit display name" title="Edit display name" disabled={!allowed} aria-describedby={restriction ? 'watchNameRestriction' : undefined} onClick={() => { setName(state.clientName); setStatus(''); setInvalid(false); setEditing(true); }}><Icon name="edit" /></Button></div>
    {restriction && <p id="watchNameRestriction" className="watch-name-restriction">{restriction}</p>}
    <Status className="sr-only">{!editing && !invalid ? status : ''}</Status>
    {editing && <Dialog title="Edit display name" returnFocusRef={trigger} initialFocusRef={input} busy={pending} onClose={close}>
      <DialogHeader title="Edit display name" onClose={close} busy={pending} />
      <form onSubmit={event => {
        event.preventDefault(); if (sending.current || !allowed) return;
        const value = name.replace(/\s+/g, ' ').trim();
        if (!value) { setInvalid(true); setStatus('Enter a display name.'); input.current?.focus(); return; }
        if (!state.connected || send({ type: 'set-name', name: value }) === false) { setStatus('Reconnect before saving your name.'); return; }
        sending.current = true; setPending(true); setInvalid(false); setStatus('');
      }}>
        <Field label="Your display name" id="watchDisplayName" ref={input} name="displayName" autoComplete="nickname" value={name} maxLength={24} required disabled={!allowed} readOnly={pending} aria-invalid={invalid || undefined} aria-describedby="watchNameStatus" onChange={event => { setName(event.target.value); setInvalid(false); setStatus(''); }} />
        <Status id="watchNameStatus" tone={invalid ? 'error' : 'neutral'}>{restriction || status || (!state.connected ? 'Reconnect before saving your name.' : '')}</Status>
        <div className="confirmation-actions"><Button disabled={pending} onClick={close}>Cancel</Button><Button type="submit" variant="primary" pending={pending} pendingLabel="Saving…" disabled={!state.connected || !allowed || name === state.clientName}>Save name</Button></div>
      </form>
    </Dialog>}
  </div>;
}

export function RoomName() {
  const { state } = useRoom();
  const [editing, setEditing] = useState(false), [name, setName] = useState(state.room.name), [error, setError] = useState('');
  const trigger = useRef(null), input = useRef(null), submitted = useRef(null);
  const { execute, pending, result, status, setStatus } = useCommand();
  useEffect(() => {
    if (submitted.current && result?.requestId === submitted.current) {
      submitted.current = null;
      if (result.type !== 'error') setEditing(false);
      else input.current?.focus();
    }
  }, [result]);
  const close = () => { if (!pending) { setEditing(false); setError(''); setStatus(''); } };
  return <>
    <div className="watch-room-name"><h1>{state.room.name}</h1>{state.role === 'host' && <Button ref={trigger} variant="quiet" icon aria-label="Edit room name" title="Edit room name" disabled={!state.connected} onClick={() => { setName(state.room.name); setError(''); setStatus(''); setEditing(true); }}><Icon name="edit" /></Button>}</div>
    {editing && <Dialog title="Edit room name" initialFocusRef={input} returnFocusRef={trigger} busy={Boolean(pending)} onClose={close}>
      <DialogHeader title="Edit room name" onClose={close} busy={Boolean(pending)} />
      <form onSubmit={event => {
        event.preventDefault();
        const value = name.replace(/\s+/g, ' ').trim();
        if (!value || value.length > 80) { setError('Enter a room name of at most 80 characters.'); input.current?.focus(); return; }
        if (state.role !== 'host') return;
        setError(''); submitted.current = execute({ type: 'set-room-name', name: value });
      }}>
        <Field label="Room name" ref={input} value={name} maxLength={80} required readOnly={Boolean(pending)} disabled={state.role !== 'host'} error={error} aria-describedby="roomNameStatus" onChange={event => { setName(event.target.value); setError(''); setStatus(''); }} />
        <Status id="roomNameStatus" tone={result?.type === 'error' && status ? 'error' : 'neutral'}>{state.role !== 'host' ? 'Only the current host can rename the room.' : !state.connected ? 'Reconnect before saving the room name.' : status}</Status>
        <div className="confirmation-actions"><Button disabled={Boolean(pending)} onClick={close}>Cancel</Button><Button type="submit" variant="primary" pending={Boolean(pending)} pendingLabel="Saving…" disabled={!state.connected || state.role !== 'host' || name === state.room.name}>Save name</Button></div>
      </form>
    </Dialog>}
  </>;
}

export function RoomToolbar() {
  const { state, roomId, disconnect } = useRoom();
  const [inviteOpen, setInviteOpen] = useState(false), [permissions, setPermissions] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false), [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState(''), [copyStatus, setCopyStatus] = useState('');
  const inviteTrigger = useRef(null), permissionsTrigger = useRef(null), leaveTrigger = useRef(null), link = useRef(null), cancelLeave = useRef(null), leavePending = useRef(false);
  const invite = new URL(state.room.invitePath || `/?room=${encodeURIComponent(roomId || 'default')}`, location.origin).href;
  const providing = state.sourceOwnerId === state.clientId || state.people.some(person => person.clientId === state.clientId && person.suppliesVideo);
  useEffect(() => { if (confirmLeave) cancelLeave.current?.focus(); }, [confirmLeave]);
  async function leave() {
    if (leavePending.current) return;
    leavePending.current = true; setLeaving(true); setLeaveError('');
    try {
      if (roomId) { const result = await post(`/rooms/${encodeURIComponent(roomId)}/api/leave`); if (result.left !== true) throw new Error('Could not leave the room. Try again.'); }
      disconnect(); navigate('/');
    } catch (error) { setLeaveError(error.message); }
    finally { leavePending.current = false; setLeaving(false); }
  }
  return <section className="watch-room-bar" aria-label="Current room">
    <div className="watch-room-title"><RoomName /><div className="watch-room-meta"><Status className="watch-connection"><span className={`status-dot ${state.connected ? 'online' : 'offline'}`} aria-hidden="true" />{state.connectionText}</Status></div></div>
    <div className="watch-room-actions"><Button ref={inviteTrigger} variant="primary" aria-label="Invite friends" onClick={() => { setCopyStatus(''); setInviteOpen(true); }}><Icon name="invite" /><span>Invite<span className="watch-action-context"> friends</span></span></Button>
      {state.role === 'host' && <Button ref={permissionsTrigger} aria-label="Room permissions" disabled={!state.connected} onClick={() => setPermissions(true)}><Icon name="settings" /><span><span className="watch-action-context">Room </span>Permissions</span></Button>}
      <Button ref={leaveTrigger} variant="quiet" className="watch-leave" aria-label="Leave room" pending={leaving} pendingLabel="Leaving…" onClick={() => providing ? setConfirmLeave(true) : void leave()}><Icon name="leave" /><span>Leave<span className="watch-action-context"> room</span></span></Button>
    </div>
    {leaveError && !confirmLeave && <Status tone="error" className="watch-room-error">{leaveError}</Status>}
    {inviteOpen && <Dialog title="Invite friends" returnFocusRef={inviteTrigger} onClose={() => setInviteOpen(false)}>
      <DialogHeader title="Invite friends" onClose={() => setInviteOpen(false)} />
      <p className="ui-dialog-description">Share this link to bring friends straight to {state.room.name}. If the room has a password, share that with them too.</p>
      <Field label="Invitation link" ref={link} value={invite} readOnly onFocus={event => event.target.select()} />
      <div className="watch-invite-actions"><Button variant="primary" onClick={async () => { try { await navigator.clipboard.writeText(invite); setCopyStatus('Invitation link copied.'); } catch { link.current?.focus(); link.current?.select(); setCopyStatus('Copy the selected invitation link using your browser or keyboard.'); } }}>Copy invitation link</Button></div>
      <Status>{copyStatus}</Status>
    </Dialog>}
    {permissions && <RoomPermissions returnFocusRef={permissionsTrigger} onClose={() => setPermissions(false)} />}
    {confirmLeave && <Dialog title="Stop sharing and leave?" returnFocusRef={leaveTrigger} busy={leaving} onClose={() => setConfirmLeave(false)}>
      <DialogHeader title="Stop sharing and leave?" />
      <p className="ui-dialog-description">This browser is sharing the video. Leaving will stop playback for everyone in the room.</p>
      <Status tone="error">{leaveError}</Status><div className="confirmation-actions"><Button ref={cancelLeave} disabled={leaving} onClick={() => setConfirmLeave(false)}>Stay in room</Button><Button variant="danger" pending={leaving} pendingLabel="Leaving…" onClick={leave}>Stop sharing and leave</Button></div>
    </Dialog>}
  </section>;
}
