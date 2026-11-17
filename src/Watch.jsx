import { createPortal } from 'react-dom';
import { useLayoutEffect, useRef, useState } from 'react';
import { Status } from './shared.jsx';
import { RoomProvider, useRoom } from './room.jsx';
import { Player } from './Player.jsx';
import { Chat } from './Chat.jsx';
import { Poll } from './Poll.jsx';
import { Participants } from './Permissions.jsx';
import { DisplayNameForm, RoomActions, RoomHeader } from './RoomControls.jsx';
import { Icon } from './Icons.jsx';
import { useAttention } from './attention.js';
import { useChatDock } from './chat-dock.js';

export function WatchContent() {
  const { state, attention } = useRoom();
  const [tab, setTab] = useState('chat');
  const theater = useRef(null);
  const dock = useChatDock(theater);
  const { open: chatOpen, setOpen: setChatOpen } = dock;
  const tabList = useRef(null), chatSlot = useRef(null), chatToggle = useRef(null);
  const attentionView = useAttention(attention, chatOpen && tab === 'chat');
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
  const selectTab = (next, focus = false) => { setTab(next); if (focus) tabList.current?.querySelector(`[data-tab="${next}"]`)?.focus({ preventScroll: true }); };
  const unread = attentionView.unread;
  const unreadLabel = `${unread} unread ${unread === 1 ? 'message' : 'messages'}`;
  const compactCount = count => count > 99 ? '99+' : count;
  const tabs = [{ key: 'chat', label: 'Chat', icon: 'chat' }, { key: 'people', label: 'People', icon: 'people' }, { key: 'upnext', label: 'Up next', icon: 'vote' }];
  const livePoll = state.poll.status === 'open';
  return <div className="watch-page" onKeyDown={event => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.target.closest('dialog') || !event.target.closest('#watchChatroom')) return;
    event.preventDefault(); setChatOpen(false); chatToggle.current?.focus({ preventScroll: true });
  }}>
    <a className="watch-skip" href="#watchMain">Skip to watch room</a>
    <RoomHeader />
    <main id="watchMain" tabIndex={-1} className="watch-layout">
      <div ref={theater} className={`watch-theater${chatOpen ? ' is-chat-open' : ''}${dock.resizing ? ' is-resizing' : ''}`} style={{ '--chat-width': `${dock.width}px` }}>
      <Player portals={portals} attentionView={attentionView} chatOpen={chatOpen} />
      {chatOpen && dock.sideBySide && <div className="watch-chat-resizer" role="separator" tabIndex={0} aria-label="Resize chat panel" title="Drag to resize chat" aria-orientation="vertical" aria-controls="watchChatroom" aria-valuemin={dock.min} aria-valuemax={dock.max} aria-valuenow={dock.width} aria-valuetext={`${dock.width} pixels`} aria-describedby="chatResizeHint" {...dock.toggleProps} />}
      <span id="chatResizeHint" className="sr-only">Drag the panel edge or use Left/Right arrow keys to resize. Home/End set the minimum/maximum width.</span>
      <button ref={chatToggle} type="button" className="watch-chat-toggle" aria-controls="watchChatroom" aria-expanded={chatOpen} aria-label={`${chatOpen ? 'Hide' : 'Show'} chat${unread ? `, ${unreadLabel}` : ''}`} aria-describedby={dock.sideBySide ? 'chatDockHint' : undefined} title={`${chatOpen ? 'Hide' : 'Show'} chat${dock.sideBySide ? '. Drag to resize' : ''}`} {...dock.toggleProps}>
        <span className="watch-chat-toggle-clip"><span className="watch-chat-toggle-surface"><Icon name="chevron" /><span className="watch-chat-toggle-label">{chatOpen ? 'Hide chat' : 'Show chat'}</span></span></span>
        {unread > 0 && <span className="watch-tab-count" aria-hidden="true">{compactCount(unread)}</span>}
      </button>
      <span id="chatDockHint" className="sr-only">Chat width {dock.width} pixels. Click to {chatOpen ? 'hide' : 'show'} chat. Drag or use Left/Right arrow keys to resize; Home/End set the minimum/maximum width.</span>
      <aside id="watchChatroom" className="chat-panel watch-lounge" aria-label="Chatroom" hidden={!chatOpen}>
        <div className="chat-heading"><DisplayNameForm><RoomActions /></DisplayNameForm></div>
        <span className="sr-only" role="status" aria-atomic="true">{unread ? unreadLabel : 'No unread messages'}</span>
        <div ref={tabList} className="watch-social-tabs" role="tablist" aria-label="Chatroom" onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault(); const current = tabs.findIndex(item => item.key === tab);
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (current + (event.key === 'ArrowRight' ? 1 : -1) + 3) % 3;
          selectTab(tabs[index].key, true);
        }}>
          {tabs.map(item => <button key={item.key} id={`${item.key === 'upnext' ? 'upNext' : item.key}Tab`} data-tab={item.key} role="tab" aria-selected={tab === item.key} aria-controls={item.key === 'chat' ? 'socialChat' : item.key === 'people' ? 'socialPeople' : 'socialUpNext'} aria-label={`${item.label}${item.key === 'chat' && unread ? `, ${unreadLabel}` : item.key === 'people' ? `, ${state.viewerCount} ${state.viewerCount === 1 ? 'participant' : 'participants'}` : item.key === 'upnext' && livePoll ? ', poll open' : ''}`} tabIndex={tab === item.key ? 0 : -1} onClick={() => selectTab(item.key)}><Icon name={item.icon} /><span className="watch-tab-label">{item.label}{((item.key === 'chat' && unread > 0) || item.key === 'people') && <span className="watch-tab-count" aria-hidden="true">{compactCount(item.key === 'people' ? state.viewerCount : unread)}</span>}{item.key === 'upnext' && livePoll && <span className="watch-tab-live" aria-hidden="true" />}</span></button>)}
        </div>
        <div id="socialChat" className="chat-body watch-chat-panel" hidden={tab !== 'chat'} role="tabpanel" aria-labelledby="chatTab">
          {state.host?.status === 'reconnecting' && <Status className="host-reconnect-status">{state.host.name || 'The host'} is reconnecting. Playback will continue when they return.</Status>}
          {livePoll && <button className="watch-poll-notice" onClick={() => selectTab('upnext', true)}><Icon name="vote" /><span><strong>A movie vote is open</strong><span>Help choose what comes next</span></span><Icon name="arrow" /></button>}
          <div ref={chatSlot} className="chat-slot" />
        </div>
        <Participants hidden={tab !== 'people'} tabbed />
        <section id="socialUpNext" className="watch-upnext-panel" hidden={tab !== 'upnext'} role="tabpanel" aria-labelledby="upNextTab">
          <Poll expanded disclosure={false} />
        </section>
      </aside>
      </div>
    </main>
    {createPortal(<Chat overlayTarget={portals.overlays} layoutKey={`${attentionView.active}:${attentionView.chatVisible}:${tab === 'chat'}`} />, portals.chat)}
    {createPortal(attentionView.floating.map(item => <span key={item.id} className="floating-reaction" style={{ left: item.left, animationDelay: item.delay }}>{item.emoji}</span>), portals.floating)}
    {createPortal(attentionView.notices.map(item => <div key={item.id} className={`reaction-item${item.message ? ' chat-notification' : ''}`}>{item.message ? <><strong>{item.name}</strong><p>{item.message}</p></> : `${item.emoji} ${item.name}`}</div>), portals.feed)}
  </div>;
}
export function Watch() { return <RoomProvider><WatchContent /></RoomProvider>; }
