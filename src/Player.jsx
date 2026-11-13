import { useEffect, useRef } from 'react';
import { createPlayer } from '../js/player/controller.js';
import { createHostFiles } from '../js/host-files.js';
import { useRoom } from './room.jsx';
import { Button, useTheme } from './shared.jsx';
import { can } from '../js/permissions.js';
import { Icon } from './Icons.jsx';

// React owns the shell. The adapter exclusively owns Movi and the status refs inside it.
export function Player({ portals, attentionView }) {
  const root = useRef(null);
  const { session, send, system, registerPlayer, attention, state } = useRoom();
  const { theme } = useTheme();
  const hasVideo = Boolean(state.media?.hasVideo || state.media?.processing);
  const providing = state.sourceOwnerId === state.clientId || state.people.some(person => person.clientId === state.clientId && person.suppliesVideo);
  useEffect(() => {
    // Resolve the semantic color after ThemeProvider applies its theme to the root.
    const frame = requestAnimationFrame(() => {
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--action-primary').trim();
      if (accent) root.current?.querySelector('#video')?.setAttribute('themecolor', accent);
    });
    return () => cancelAnimationFrame(frame);
  }, [theme]);
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
    <h2 id="player-title" className="sr-only">Shared video</h2>
    <div id="videoShell" className="video-shell">
      <movi-player id="video" playsinline="" preload="auto" engine="native wasm" wasmurl="/vendor/movi.wasm" smoothwarning="" theme={theme} objectfit="contain" titlemode="fullscreen">Your browser does not support the WatchParty player.</movi-player>
      <div id="videoPlaceholder" className="video-placeholder"><span className="placeholder-icon" aria-hidden="true"><Icon name="video" /></span><strong>Waiting for the host</strong><span>The host will choose a video file and start the watch party.</span></div>
      <div id="viewerControls" className="viewer-controls" hidden><button id="fullscreenButton" className="fullscreen-button" type="button" aria-label="Enter fullscreen" title="Fullscreen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /></svg></button></div>
      <button id="fullscreenChatToggle" className={`fullscreen-chat-toggle${!attentionView.controlsVisible && !attentionView.revealing ? ' is-idle' : ''}`} type="button" aria-controls="fullscreenChat" aria-label={`${attentionView.chatVisible ? 'Hide' : 'Show'} chat${attentionView.unread ? `, ${attentionView.unread} unread messages` : ''}`} hidden>
        <span>{attentionView.chatVisible ? 'Hide chat' : 'Show chat'}</span><span className="fullscreen-chat-unread" aria-hidden="true" hidden={!attentionView.unread}>{attentionView.unread > 99 ? '99+' : attentionView.unread}</span>
      </button>
      <section id="fullscreenChat" className="fullscreen-chat" aria-label="Fullscreen chat" hidden />
    </div>
    <div className="watch-media-bar"><div className="watch-media-title"><h3 id="fileName">No video selected</h3>{hasVideo && <p className="watch-playback-summary">{state.role === 'host' ? 'You control shared playback' : can(state, 'playPause') ? 'Play and pause are shared with the room' : 'Playback is controlled by the host'}</p>}</div>
      <div id="hostControls" className="host-controls" hidden><Button id="chooseVideoButton" variant={hasVideo ? 'secondary' : 'primary'}><Icon name={hasVideo ? 'video' : 'plus'} />{hasVideo ? 'Replace video' : 'Choose video'}</Button></div>
      <span id="roleBadge" className="sr-only" aria-hidden="true">Viewer</span>
    </div>
    {state.role === 'host' && hasVideo && providing && <p className="watch-sharing-status">Sharing from this browser. Keep it open while everyone watches.</p>}
    <details className="watch-player-help"><summary>Playback &amp; sharing details</summary><p id="syncStatus" className="sync-status">Waiting for host</p>{can(state, 'chooseVideo') && <p>Choose a video from this device, with optional subtitle files. Keep the sharing browser open while everyone watches. Captions and quality controls are in the player.</p>}</details>
    <p id="fileSharingStatus" className="watch-sharing-status" hidden>You are sharing this video. Keep this browser open while everyone watches.</p>
  </section>;
}
