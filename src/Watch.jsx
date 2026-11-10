import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { can } from '../js/permissions.js';
import { Footer, Header, navigate, post, Status } from './shared.jsx';
import { RoomProvider, useRoom } from './room.jsx';
import { Player } from './Player.jsx';
import { Chat } from './Chat.jsx';
import { Poll } from './Poll.jsx';
import { Participants, RoomPermissions } from './Permissions.jsx';
import { useAttention } from './attention.js';

function useWide() {
  const [wide, setWide] = useState(() => matchMedia('(min-width: 1100px)').matches);
  useEffect(() => { const media = matchMedia('(min-width: 1100px)'), change = () => setWide(media.matches); media.addEventListener('change', change); return () => media.removeEventListener('change', change); }, []);
  return wide;
}
function RoomBar() {
  const { state, send, roomId, disconnect } = useRoom();
  const [open, setOpen] = useState(null), [permissions, setPermissions] = useState(false);
  const [name, setName] = useState(state.clientName), [nameStatus, setNameStatus] = useState(''), [invalid, setInvalid] = useState(false);
  const [status, setStatus] = useState(''), [leaving, setLeaving] = useState(false);
  const bar = useRef(null), inviteTrigger = useRef(null), optionsTrigger = useRef(null), permissionTrigger = useRef(null);
  const invite = new URL(state.room.invitePath || `/?room=${encodeURIComponent(roomId || 'default')}`, location.origin).href;
  useEffect(() => setName(state.clientName), [state.clientName]);
  useEffect(() => {
    const m = state.nameFeedback;
    if (m?.type === 'name-updated' || m?.type === 'name-rejected') { setNameStatus(m.message || (m.type === 'name-updated' ? `Your display name is now ${m.name}.` : 'That display name is already in use.')); setInvalid(m.type === 'name-rejected'); }
  }, [state.event, state.lastMessage]);
  useEffect(() => {
    const outside = event => { if (!bar.current?.contains(event.target)) setOpen(null); };
    const escape = event => { if (event.key === 'Escape' && open) { setOpen(null); (open === 'invite' ? inviteTrigger : optionsTrigger).current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  async function leave() {
    if (leaving) return;
    setLeaving(true); setStatus('Leaving room…');
    try { if (roomId) { const result = await post(`/rooms/${encodeURIComponent(roomId)}/api/leave`); if (result.left !== true) throw new Error('Could not leave the room.'); } disconnect(); navigate('/'); }
    catch (error) { setStatus(error.message); setLeaving(false); }
  }
  return <section ref={bar} className="room-info" aria-label="Current room">
    <div className="room-info-bar"><div className="room-info-current"><p className="room-info-label">YOUR WATCH PARTY</p><p className="room-info-name">{state.room.name}</p></div><div className="room-bar-actions">
      <div className="connection" aria-live="polite"><span className={`status-dot ${state.connected ? 'online' : 'offline'}`} /><span>{state.connectionText}</span></div>
      <button ref={inviteTrigger} className="room-info-invite" aria-expanded={open === 'invite'} aria-controls="roomInfoDetails" onClick={() => setOpen(value => value === 'invite' ? null : 'invite')}>Invite <svg className="room-info-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m5 7.5 5 5 5-5" /></svg></button>
      <button ref={optionsTrigger} className="lounge-button" aria-expanded={open === 'options'} aria-controls="roomMenu" onClick={() => setOpen(value => value === 'options' ? null : 'options')}>Room options</button>
    </div></div>
    <div id="roomMenu" className="lounge-disclosure room-menu" hidden={open !== 'options'}><h2>Your profile</h2>
      <form className="name-form" autoComplete="off" onSubmit={event => { event.preventDefault(); const value = name.replace(/\s+/g, ' ').trim(); if (!value) { setNameStatus('Enter a display name.'); setInvalid(true); return; } if (!can(state, 'changeName')) return; setNameStatus(send({ type: 'set-name', name: value }) === false ? 'Reconnect before changing your name.' : 'Saving name…'); }}>
        <label htmlFor="displayNameInput">Display name</label><div className="name-form-row"><input id="displayNameInput" name="displayName" value={name} onChange={event => { setName(event.target.value); setInvalid(false); }} aria-invalid={invalid || undefined} maxLength={24} placeholder="Display name" required disabled={!can(state, 'changeName')} /><button disabled={!state.connected || !can(state, 'changeName')}>Save</button></div><Status className="control-help">{nameStatus}</Status>
      </form>
      {state.role === 'host' && <div className="room-menu-settings"><h2>Room settings</h2><button ref={permissionTrigger} className="room-menu-action" disabled={!state.connected} onClick={() => setPermissions(true)}>Viewer permissions</button></div>}
      <div className="room-menu-leave"><button className="room-action-button" disabled={leaving} onClick={leave}>Leave room</button><Status className="room-action-status">{status}</Status></div>
    </div>
    <div id="roomInfoDetails" className="room-info-details" hidden={open !== 'invite'}><p className="room-info-label">INVITATION LINK</p><div className="room-info-code-row"><output className="room-info-code room-info-link">{invite}</output><button className="room-info-copy" onClick={async () => { try { await navigator.clipboard.writeText(invite); setStatus('Invitation link copied.'); } catch { setStatus('Select the invitation link to copy it.'); } }}>Copy</button></div><Status className="room-info-status">{status}</Status></div>
    {permissions && <RoomPermissions onClose={() => { setPermissions(false); permissionTrigger.current?.focus(); }} />}
  </section>;
}
function WatchContent() {
  const { state, send, attention } = useRoom();
  const wide = useWide();
  const [tab, setTab] = useState('chat'), [chatMenu, setChatMenu] = useState(false), [expanded, setExpanded] = useState(false);
  const startingPoll = useRef(false);
  const socialVisible = wide || tab === 'chat';
  const attentionView = useAttention(attention, socialVisible);
  const chatSlot = useRef(null), menuTrigger = useRef(null), menuPanel = useRef(null);
  const [portals] = useState(() => {
    const make = className => { const node = document.createElement('div'); node.className = className; return node; };
    const feed = make('reaction-feed'); feed.setAttribute('role', 'log'); feed.setAttribute('aria-live', 'polite'); feed.setAttribute('aria-label', 'Recent messages and reactions');
    const floating = make('floating-reactions'); floating.setAttribute('aria-hidden', 'true');
    return { chat: make('chat-portal'), overlays: make('overlay-portal'), menu: make('overlay-portal'), feed, floating };
  });
  useLayoutEffect(() => {
    chatSlot.current.appendChild(portals.chat);
    for (const node of [portals.overlays, portals.menu, portals.feed, portals.floating]) document.body.appendChild(node);
    return () => { for (const node of Object.values(portals)) node.remove(); };
  }, [portals]);
  useEffect(() => { setExpanded(state.poll.status === "open" && startingPoll.current); startingPoll.current = false; }, [state.poll.id, state.poll.status]);
  useEffect(() => {
    const outside = event => { if (!menuPanel.current?.contains(event.target) && !menuTrigger.current?.contains(event.target)) setChatMenu(false); };
    const escape = event => { if (event.key === 'Escape' && chatMenu) { setChatMenu(false); menuTrigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [chatMenu]);
  const unread = attentionView.unread > 99 ? '99+' : attentionView.unread;
  return <>
    <Header><a className="rooms-link" href="/">Browse rooms</a></Header>
    <main className="watch-layout grid min-w-0 gap-4"><RoomBar /><Player portals={portals} attentionView={attentionView} />
      <aside className={`chat-panel${state.poll.status === 'open' && expanded ? ' poll-expanded' : ''}`} aria-labelledby="chat-title">
        <div className="chat-heading"><div><h2 id="chat-title">The lounge</h2><span className="viewer-count">{state.viewerCount} online</span></div><div className="chat-heading-actions">
          <button ref={menuTrigger} className="lounge-button" aria-label="Chat options" aria-expanded={chatMenu} aria-controls="chatMenu" onClick={() => setChatMenu(value => !value)}>•••</button>
          <div id="chatMenu" ref={menuPanel} className="lounge-disclosure chat-menu" hidden={!chatMenu}><p className="control-help">Choose what to watch together.</p>{can(state, 'startPoll') && state.poll.status !== 'open' && <button className="start-poll-button" disabled={!state.connected} onClick={() => { startingPoll.current = send({ type: 'start-video-poll' }) !== false; setChatMenu(false); menuTrigger.current?.focus(); }}>Start poll</button>}</div>
        </div></div>
        <div className="social-tabs" role="tablist" aria-label="Lounge" hidden={wide} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'chat' : event.key === 'End' ? 'people' : tab === 'chat' ? 'people' : 'chat'; setTab(next); event.currentTarget.querySelector(`#${next}Tab`).focus(); } }}>
          <button id="chatTab" role="tab" aria-selected={tab === 'chat'} aria-controls="socialChat" aria-label={`Chat${unread ? `, ${unread} unread messages` : ''}`} tabIndex={tab === 'chat' ? 0 : -1} onClick={() => setTab('chat')}>Chat {Boolean(unread) && <span className="social-unread">{unread}</span>}</button>
          <button id="peopleTab" role="tab" aria-selected={tab === 'people'} aria-controls="socialPeople" tabIndex={tab === 'people' ? 0 : -1} onClick={() => setTab('people')}>People</button>
        </div>
        <Participants hidden={!wide && tab !== 'people'} tabbed={!wide} />
        <div id="socialChat" className="chat-body" hidden={!socialVisible} role={wide ? undefined : 'tabpanel'} aria-labelledby={wide ? 'chat-title' : 'chatTab'}>
          {state.host?.status === 'reconnecting' && <Status className="host-reconnect-status">{state.host.name || 'The host'} is reconnecting. Waiting briefly before assigning a new host.</Status>}
          <Poll expanded={expanded} onToggle={() => setExpanded(value => !value)} /><div ref={chatSlot} className="chat-slot" />
        </div>
      </aside>
    </main>
    {createPortal(<Chat overlayTarget={portals.overlays} layoutKey={`${attentionView.active}:${attentionView.chatVisible}:${socialVisible}`} />, portals.chat)}
    {createPortal(attentionView.floating.map(item => <span key={item.id} className="floating-reaction" style={{ left: item.left, animationDelay: item.delay }}>{item.emoji}</span>), portals.floating)}
    {createPortal(attentionView.notices.map(item => <div key={item.id} className={`reaction-item${item.message ? ' chat-notification' : ''}`}>{item.message ? <><strong>{item.name}</strong><p>{item.message}</p></> : `${item.emoji} ${item.name}`}</div>), portals.feed)}
    <Footer />
  </>;
}
export function Watch() { return <RoomProvider><WatchContent /></RoomProvider>; }
