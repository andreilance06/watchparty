import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Header, Status } from './shared.jsx';
import { RoomProvider, useRoom } from './room.jsx';
import { Player } from './Player.jsx';
import { Chat } from './Chat.jsx';
import { Poll, PollLauncher } from './Poll.jsx';
import { Participants } from './Permissions.jsx';
import { DisplayNameForm, RoomToolbar } from './RoomControls.jsx';
import { Icon } from './Icons.jsx';
import { useAttention } from './attention.js';
import { can } from '../js/permissions.js';

function LastPoll({ poll }) {
  const { state } = useRoom();
  const result = poll.result;
  const winners = result?.suggestions?.filter(item => result.winnerIds?.includes(item.id)) || [];
  return <div className="watch-poll-empty"><span className="watch-empty-icon"><Icon name="vote" /></span>
    <h3>{winners.length ? winners.map(item => item.title).join(' / ') : poll.status === 'closed' ? 'No winner this time' : 'What are we watching next?'}</h3>
    <p>{winners.length ? 'The vote is in. The host can choose the video file when everyone is ready.' : can(state, 'startPoll') ? 'Start a poll to suggest movies and pick a favorite together.' : 'The host can start a movie vote. When it opens, come here to see the suggestions and results.'}</p>
  </div>;
}
export function WatchContent() {
  const { state, attention } = useRoom();
  const [tab, setTab] = useState('chat');
  const startingPoll = useRef(false), tabList = useRef(null), chatSlot = useRef(null);
  const attentionView = useAttention(attention, tab === 'chat');
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
  useEffect(() => {
    if (state.poll.status === 'open' && startingPoll.current) selectTab('upnext', true);
    startingPoll.current = false;
  }, [state.poll.id, state.poll.status]);
  const unread = attentionView.unread;
  const unreadLabel = `${unread} unread ${unread === 1 ? 'message' : 'messages'}`;
  const compactCount = count => count > 99 ? '99+' : count;
  const tabs = [{ key: 'chat', label: 'Chat', icon: 'chat' }, { key: 'people', label: 'People', icon: 'people' }, { key: 'upnext', label: 'Up next', icon: 'vote' }];
  const livePoll = state.poll.status === 'open';
  return <div className="watch-page">
    <a className="watch-skip" href="#watchMain">Skip to watch room</a>
    <Header brandHeading={false}><a className="rooms-link" href="/">Browse rooms</a></Header>
    <main id="watchMain" tabIndex={-1} className="watch-layout"><RoomToolbar /><Player portals={portals} attentionView={attentionView} />
      <aside className="chat-panel watch-lounge" aria-label="Chatroom">
        <div className="chat-heading"><DisplayNameForm /><PollLauncher onStart={() => { startingPoll.current = true; selectTab('upnext', true); }} /></div>
        <span className="sr-only" role="status" aria-atomic="true">{unread ? unreadLabel : 'No unread messages'}</span>
        <div ref={tabList} className="watch-social-tabs" role="tablist" aria-label="Chatroom" onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault(); const current = tabs.findIndex(item => item.key === tab);
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (current + (event.key === 'ArrowRight' ? 1 : -1) + 3) % 3;
          selectTab(tabs[index].key, true);
        }}>
          {tabs.map(item => <button key={item.key} id={`${item.key === 'upnext' ? 'upNext' : item.key}Tab`} data-tab={item.key} role="tab" aria-selected={tab === item.key} aria-controls={item.key === 'chat' ? 'socialChat' : item.key === 'people' ? 'socialPeople' : 'socialUpNext'} aria-label={`${item.label}${item.key === 'chat' && unread ? `, ${unreadLabel}` : item.key === 'people' ? `, ${state.viewerCount} ${state.viewerCount === 1 ? 'participant' : 'participants'}` : item.key === 'upnext' && livePoll ? ', poll open' : ''}`} tabIndex={tab === item.key ? 0 : -1} onClick={() => selectTab(item.key)}><Icon name={item.icon} />{item.label}{((item.key === 'chat' && unread > 0) || item.key === 'people') && <span className="watch-tab-count" aria-hidden="true">{compactCount(item.key === 'people' ? state.viewerCount : unread)}</span>}{item.key === 'upnext' && livePoll && <span className="watch-tab-live" aria-hidden="true" />}</button>)}
        </div>
        <div id="socialChat" className="chat-body watch-chat-panel" hidden={tab !== 'chat'} role="tabpanel" aria-labelledby="chatTab">
          {state.host?.status === 'reconnecting' && <Status className="host-reconnect-status">{state.host.name || 'The host'} is reconnecting. Playback will continue when they return.</Status>}
          {livePoll && <button className="watch-poll-notice" onClick={() => selectTab('upnext', true)}><Icon name="vote" /><span><strong>A movie vote is open</strong><span>Help choose what comes next</span></span><Icon name="arrow" /></button>}
          <div ref={chatSlot} className="chat-slot" />
        </div>
        <Participants hidden={tab !== 'people'} tabbed />
        <section id="socialUpNext" className="watch-upnext-panel" hidden={tab !== 'upnext'} role="tabpanel" aria-labelledby="upNextTab">
          <Poll expanded disclosure={false} />{!livePoll && <LastPoll poll={state.poll} />}
        </section>
      </aside>
    </main>
    {createPortal(<Chat overlayTarget={portals.overlays} layoutKey={`${attentionView.active}:${attentionView.chatVisible}:${tab === 'chat'}`} />, portals.chat)}
    {createPortal(attentionView.floating.map(item => <span key={item.id} className="floating-reaction" style={{ left: item.left, animationDelay: item.delay }}>{item.emoji}</span>), portals.floating)}
    {createPortal(attentionView.notices.map(item => <div key={item.id} className={`reaction-item${item.message ? ' chat-notification' : ''}`}>{item.message ? <><strong>{item.name}</strong><p>{item.message}</p></> : `${item.emoji} ${item.name}`}</div>), portals.feed)}
  </div>;
}
export function Watch() { return <RoomProvider><WatchContent /></RoomProvider>; }
