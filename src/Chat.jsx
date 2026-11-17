import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EMOJI_CHOICES } from '../js/emoji-choices.js';
import { can } from '../js/permissions.js';
import { createClientId } from '../js/utils/client-id.js';
import { Button, Input, Status } from './shared.jsx';
import { useRoom } from './room.jsx';
import { Popover } from './Popover.jsx';

const QUICK = ['❤️', '👍', '😂', '🔥', '😮', '😢', '👏', '🎉'];
export function Chat({ overlayTarget, layoutKey }) {
  const { state, send, attention } = useRoom();
  const canReply = can(state, 'replyChat') && can(state, 'sendChat'), canReact = can(state, 'reactMessages');
  const [draft, setDraft] = useState(''), [reply, setReply] = useState(null), [status, setStatus] = useState('');
  const [pending, setPending] = useState(null), [atLatest, setAtLatest] = useState(true);
  const pendingRef = useRef(null), draftRef = useRef(draft), replyRef = useRef(reply);
  draftRef.current = draft; replyRef.current = reply;
  const [picker, setPicker] = useState(null), [menu, setMenu] = useState(null), [expanded, setExpanded] = useState(false), [highlight, setHighlight] = useState(null);
  const [search, setSearch] = useState('');
  const input = useRef(null), messages = useRef(null), press = useRef(null), highlightTimer = useRef(null), suppress = useRef(0);
  const selection = useRef({ start: 0, end: 0 });
  const cancelPress = () => { clearTimeout(press.current?.timer); press.current = null; };
  const closeOverlays = () => { setMenu(null); setPicker(null); setExpanded(false); cancelPress(); };
  useEffect(() => { closeOverlays(); }, [layoutKey, JSON.stringify(state.permissions), state.role]);
  useEffect(() => () => { clearTimeout(press.current?.timer); clearTimeout(highlightTimer.current); }, []);
  const scrollLatest = () => { if (messages.current) messages.current.scrollTop = messages.current.scrollHeight; setAtLatest(true); attention.current?.setAtLatest(true); };
  useLayoutEffect(() => { if (atLatest) scrollLatest(); }, [state.messages, layoutKey]);
  useEffect(() => { attention.current?.onChatShown(() => { if (atLatest) requestAnimationFrame(scrollLatest); }); }, [atLatest, attention]);
  useEffect(() => {
    const request = pendingRef.current;
    const message = state.responses.find(item => item.requestId === request?.id);
    if (!request || message?.requestId !== request.id) return;
    if (message.type === 'chat' && message.clientId === state.clientId) {
      if (draftRef.current === request.draft) setDraft('');
      if (replyRef.current === request.reply) setReply(null);
      setStatus('');
    } else if (message.type === 'error') setStatus(message.message);
    else return;
    pendingRef.current = null; setPending(null);
  }, [state.event, state.lastMessage, state.clientId]);
  useEffect(() => {
    if (!state.connected && pendingRef.current) { pendingRef.current = null; setPending(null); setStatus('Connection lost. Your draft is saved here; reconnect before sending again.'); }
  }, [state.connected]);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => { pendingRef.current = null; setPending(null); setStatus('The message was not acknowledged. Your draft is saved here.'); }, 10000);
    return () => clearTimeout(timer);
  }, [pending]);
  useEffect(() => { if (menu && !state.messages.some(item => item.commentId === menu.id)) setMenu(null); }, [state.messages, menu]);
  function submit(event) {
    event.preventDefault();
    if (!draft.trim() || pendingRef.current) return;
    if (!can(state, 'sendChat') || reply && !can(state, 'replyChat')) { setStatus('The host has disabled this action. Your draft is saved here.'); return; }
    const id = createClientId();
    if (!state.connected || send({ type: 'chat', message: draft.trim(), requestId: id, ...(reply ? { replyToId: reply.commentId } : {}) }) === false) { setStatus('Reconnect to send your message. Your draft is saved here.'); return; }
    pendingRef.current = { id, draft, reply }; setPending(id); setStatus(''); input.current.focus();
  }
  function react(comment, emoji) {
    if (!can(state, 'reactMessages') || !state.connected || send({ type: 'comment-reaction', commentId: comment.commentId, emoji: comment.myReaction === emoji ? null : emoji }) === false) setStatus('Reconnect or ask the host to enable message reactions.');
  }
  function openMenu(event, comment, point) {
    if (!canReply && !canReact) return;
    event.preventDefault(); event.stopPropagation(); cancelPress(); setPicker(null); setExpanded(false);
    setMenu({ id: comment.commentId, trigger: event.currentTarget, point });
  }
  function viewOriginal(replyTo) {
    const original = messages.current.querySelector(`[data-comment-id="${CSS.escape(replyTo.commentId)}"]`);
    if (!original) { setStatus('Original message unavailable'); return; }
    original.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    setAtLatest(false); attention.current?.setAtLatest(false); setHighlight(replyTo.commentId);
    clearTimeout(highlightTimer.current); highlightTimer.current = setTimeout(() => setHighlight(null), 1600);
  }
  function chooseEmoji(emoji) {
    if (can(state, 'sendChat')) {
      const { start, end } = selection.current;
      const next = draftRef.current.slice(0, start) + emoji + draftRef.current.slice(end);
      if (next.length > 300) return;
      setDraft(next); selection.current = { start: start + emoji.length, end: start + emoji.length };
      requestAnimationFrame(() => input.current?.setSelectionRange(selection.current.start, selection.current.end));
    }
  }
  const selected = menu && state.messages.find(item => item.commentId === menu.id);
  return <div className="chat-conversation">
    <div id="chatMessages" ref={messages} className="chat-messages" role="log" aria-live="polite" aria-label="Chat messages" onScroll={() => {
      const node = messages.current; if (!node.getBoundingClientRect().height) return;
      const latest = node.scrollHeight - node.scrollTop - node.clientHeight < 48; setAtLatest(latest); attention.current?.setAtLatest(latest);
    }}>
      {state.messages.map((comment, index) => {
        const sameSender = other => Boolean(other && !other.system && comment.clientId && other.clientId === comment.clientId && other.name === comment.name && other.isOwn === comment.isOwn);
        const grouped = sameSender(state.messages[index - 1]), continues = sameSender(state.messages[index + 1]);
        return comment.system ? <div className="system-message" key={comment.id}>{comment.message}</div> : <article key={comment.id} data-comment-id={comment.commentId} className={`chat-message${comment.isOwn ? ' self' : ''}${grouped ? ' grouped' : ''}${continues ? ' continues' : ''}${menu?.id === comment.commentId ? ' actions-open' : ''}${highlight === comment.commentId ? ' reply-highlight' : ''}`} tabIndex={0} aria-haspopup="menu" aria-expanded={menu?.id === comment.commentId} aria-description="Tap on mobile, right-click, or press Enter for reply and reactions."
        onClick={event => {
          if (event.target.closest('button, a') || window.getSelection()?.toString()) return;
          if (['touch', 'pen'].includes(event.nativeEvent.pointerType) || matchMedia('(max-width: 767px), (pointer: coarse)').matches) openMenu(event, comment);
        }}
        onContextMenu={event => openMenu(event, comment, { x: event.clientX, y: event.clientY })}
        onKeyDown={event => { if (event.target === event.currentTarget && (['Enter', ' ', 'ContextMenu'].includes(event.key) || event.key === 'F10' && event.shiftKey)) openMenu(event, comment); }}
        onPointerDown={event => { cancelPress(); if (event.target.closest('button, a') || !['touch', 'pen'].includes(event.pointerType) || event.isPrimary === false) return;
          const trigger = event.currentTarget, x = event.clientX, y = event.clientY;
          press.current = { x, y, timer: setTimeout(() => { suppress.current = Date.now() + 800; setPicker(null); setExpanded(false); setMenu({ id: comment.commentId, trigger, point: { x, y } }); }, 500) };
        }} onPointerMove={event => { if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 10) cancelPress(); }} onPointerUp={cancelPress} onPointerCancel={cancelPress} onClickCapture={event => { if (Date.now() < suppress.current) { event.preventDefault(); event.stopPropagation(); } }}>
        {!grouped && <div className="meta"><span className="name">{comment.name}</span></div>}
        <time>{comment.time}</time>
        {comment.replyTo && <button className="chat-reply-quote" aria-label={`View original message from ${comment.replyTo.name}: ${comment.replyTo.message}`} onClick={() => viewOriginal(comment.replyTo)}><strong>{comment.replyTo.name}</strong><span>{comment.replyTo.message}</span></button>}
        <p>{comment.message}</p>
        <div className="comment-reactions">{[...new Set((comment.reactions || []).map(item => item.emoji))].map(emoji => {
          const names = comment.reactions.filter(item => item.emoji === emoji).map(item => item.name || 'Guest');
          return <button key={emoji} className="comment-reaction" disabled={!state.connected || !can(state, 'reactMessages')} aria-pressed={comment.myReaction === emoji} aria-label={`${emoji}, ${names.length} reactions from ${names.join(', ')}${comment.myReaction === emoji ? ', your reaction' : ''}`} title={names.join(', ')} onClick={() => react(comment, emoji)}><span aria-hidden="true">{emoji}</span><span>{names.length}</span></button>;
        })}<span key={comment.myReaction || 'none'} className="comment-reaction-feedback pop" aria-hidden="true">{comment.myReaction}</span></div>
      </article>; })}
    </div>
    {!atLatest && <Button className="chat-jump-latest" onClick={scrollLatest}>↓ Latest messages</Button>}
    <form className="chat-form" autoComplete="off" aria-busy={Boolean(pending)} onSubmit={submit}>
      {reply && <div className="chat-reply-preview"><div className="chat-reply-summary"><strong>Reply to {reply.name}</strong><span>{reply.message}</span></div><button type="button" aria-label="Cancel reply" onClick={() => { setReply(null); input.current.focus(); }}>×</button></div>}
      {status && <Status className="chat-send-status">{status}</Status>}
      {!can(state, 'sendChat') ? <Status className="chat-permission-status">Chat is read-only for you. Ask the host to enable messages. Your draft is kept here.</Status> : !state.connected && <Status className="chat-permission-status">Reconnect to send messages. Your draft is kept here.</Status>}
      <label className="sr-only" htmlFor="chatInput">Message</label>
      <div className="chat-compose-row"><Input ref={input} id="chatInput" name="message" value={draft} onChange={event => setDraft(event.target.value)} aria-disabled={!can(state, 'sendChat')} maxLength={300} placeholder="Say something..." required />
        <Button icon variant="quiet" className="chat-emoji-button" aria-label="Message emoji" aria-expanded={Boolean(picker)} disabled={!can(state, 'sendChat')} onClick={event => {
          if (picker) { setPicker(null); return; }
          selection.current = { start: input.current.selectionStart ?? draft.length, end: input.current.selectionEnd ?? draft.length };
          setMenu(null); setSearch(''); setPicker(event.currentTarget);
        }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M8 14a4 4 0 0 0 8 0M8 9h.01M16 9h.01" /></svg></Button><Button type="submit" variant="primary" aria-label="Send message" pending={Boolean(pending)} pendingLabel="Sending…" disabled={!state.connected || !can(state, 'sendChat') || Boolean(reply && !can(state, 'replyChat'))}>Send</Button>
      </div>
    </form>
    {picker && <Popover target={overlayTarget} trigger={picker} className="emoji-picker" label="Message emoji" onClose={() => setPicker(null)}>
      <p className="emoji-picker-hint">Insert an emoji into your message.</p>
      <label className="sr-only" htmlFor="emojiSearch">Search emojis</label><Input className="emoji-search" id="emojiSearch" name="emojiSearch" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search emojis..." />
      <div className="emoji-picker-grid" aria-label="Emoji choices">{EMOJI_CHOICES.filter(item => `${item.emoji} ${item.label}`.includes(search.trim().toLowerCase())).map(item => <button className="emoji-choice" type="button" key={item.emoji} aria-label={item.label} title={item.label} onClick={() => chooseEmoji(item.emoji)}>{item.emoji}</button>)}</div>
      {!EMOJI_CHOICES.some(item => `${item.emoji} ${item.label}`.includes(search.trim().toLowerCase())) && <p className="emoji-picker-empty">No matching emojis.</p>}
    </Popover>}
    {selected && <Popover target={overlayTarget} trigger={menu.trigger} point={menu.point} className={`message-menu message-bubble-menu${expanded ? ' is-expanded' : ''}`} label="Message actions" menu onClose={() => { setMenu(null); setExpanded(false); }}>
      {canReact && <div className="message-menu-reactions" role="group" aria-label="Quick reactions">{QUICK.map(emoji => <button className={`message-menu-reaction${selected.myReaction === emoji ? ' selected' : ''}`} role="menuitem" key={emoji} disabled={!state.connected || !can(state, 'reactMessages')} aria-label={`${selected.myReaction === emoji ? 'Remove your' : 'React with'} ${EMOJI_CHOICES.find(item => item.emoji === emoji)?.label || emoji}`} onClick={() => { react(selected, emoji); if (!expanded) { setMenu(null); menu.trigger.focus(); } }}>{emoji}</button>)}<button role="menuitem" className="message-menu-more" aria-label="More reactions" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button></div>}
      {canReact && expanded && <div className="message-menu-expanded" role="group" aria-label="More reactions">{EMOJI_CHOICES.filter(item => !QUICK.includes(item.emoji)).map(item => <button className={`message-menu-reaction message-menu-extra${selected.myReaction === item.emoji ? ' selected' : ''}`} role="menuitem" key={item.emoji} disabled={!state.connected || !can(state, 'reactMessages')} aria-label={`React with ${item.label}`} onClick={() => react(selected, item.emoji)}>{item.emoji}</button>)}</div>}
      {canReply && <button className="message-menu-action" role="menuitem" disabled={!can(state, 'sendChat') || !can(state, 'replyChat')} onClick={() => { setReply(selected); setStatus(''); setMenu(null); input.current.focus(); }}>↩ Reply</button>}
    </Popover>}
  </div>;
}
