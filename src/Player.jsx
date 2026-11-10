import { useEffect, useRef } from 'react';
import { createPlayer } from '../js/player/controller.js';
import { createHostFiles } from '../js/host-files.js';
import { useRoom } from './room.jsx';
import { useTheme } from './shared.jsx';

// React owns the shell. The adapter exclusively owns Movi and the status refs inside it.
export function Player({ portals, attentionView }) {
  const root = useRef(null);
  const { session, send, system, registerPlayer, attention, state } = useRoom();
  const { theme } = useTheme();
  useEffect(() => {
    const node = root.current;
    const ids = ['video', 'videoShell', 'videoPlaceholder', 'hostControls', 'chooseVideoButton', 'viewerControls', 'fullscreenButton', 'roleBadge', 'fileName', 'syncStatus', 'fullscreenChat', 'fullscreenChatToggle', 'fileSharingStatus'];
    const elements = Object.fromEntries(ids.map(id => [id, node.querySelector(`#${id}`)]));
    elements.placeholderTitle = elements.videoPlaceholder.querySelector('strong');
    elements.placeholderText = elements.videoPlaceholder.querySelector('span:last-child');
    Object.assign(elements, { chatConversation: portals.chat, chatMessages: portals.chat.querySelector('#chatMessages'), floatingReactions: portals.floating, reactionFeed: portals.feed, emojiPicker: portals.overlays, messageMenu: portals.menu });
    const files = createHostFiles({ send, report: system });
    const controller = createPlayer({ elements, state: session.current, send, report: system, files, attention: attention.current });
    const controls = event => attention.current?.controlsChange(event.detail.visible);
    elements.video.addEventListener('controlschange', controls);
    registerPlayer({ files, controller });
    return () => { registerPlayer(null); elements.video.removeEventListener('controlschange', controls); controller.destroy(); };
  }, [session, send, system, registerPlayer, attention, portals]);
  return <section ref={root} className="player-panel" aria-labelledby="player-title">
    <div id="videoShell" className="video-shell">
      <movi-player id="video" playsinline="" preload="auto" engine="native wasm" wasmurl="/vendor/movi.wasm" smoothwarning="" theme={theme} themecolor="#7c5cff" objectfit="contain" titlemode="fullscreen">Your browser does not support the WatchParty player.</movi-player>
      <div id="videoPlaceholder" className="video-placeholder"><span className="placeholder-icon" aria-hidden="true">▶</span><strong>Waiting for the host</strong><span>The host will choose a video file and start the watch party.</span></div>
      <div id="viewerControls" className="viewer-controls" hidden><button id="fullscreenButton" className="fullscreen-button" type="button" aria-label="Enter fullscreen" title="Fullscreen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /></svg></button></div>
      <button id="fullscreenChatToggle" className={`fullscreen-chat-toggle${!attentionView.controlsVisible && !attentionView.revealing ? ' is-idle' : ''}`} type="button" aria-controls="fullscreenChat" aria-label={`${attentionView.chatVisible ? 'Hide' : 'Show'} chat${attentionView.unread ? `, ${attentionView.unread} unread messages` : ''}`} hidden>
        <span>{attentionView.chatVisible ? 'Hide chat' : 'Show chat'}</span><span className="fullscreen-chat-unread" aria-hidden="true" hidden={!attentionView.unread}>{attentionView.unread > 99 ? '99+' : attentionView.unread}</span>
      </button>
      <section id="fullscreenChat" className="fullscreen-chat" aria-label="Fullscreen chat" hidden />
    </div>
    <div className="player-info"><div><h2 id="player-title" className="eyebrow">NOW PLAYING</h2><h3 id="fileName">No video selected</h3></div><div className="player-local-controls"><span id="roleBadge" className="role-badge">Viewer</span><p id="syncStatus" className="sync-status">Waiting for host</p></div></div>
    <div id="hostControls" className="host-controls" hidden><button id="chooseVideoButton" className="file-button" type="button"><span aria-hidden="true">＋</span> Choose Video</button><p className="control-help">Choose one video and optional subtitle files from this device. Keep this page open while sharing.</p></div>
    <p id="fileSharingStatus" className="control-help px-4 pb-4" hidden>You are sharing the current video. Keep this page open while others watch.</p>
  </section>;
}
