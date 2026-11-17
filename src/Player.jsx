import { useEffect, useRef, useState } from 'react';
import { createPlayer } from '../js/player/controller.js';
import { createHostFiles } from '../js/host-files.js';
import { createScreenShare } from '../js/screen-share.js';
import { useRoom } from './room.jsx';
import { Button, Status, useTheme } from './shared.jsx';
import { can } from '../js/permissions.js';
import { Icon } from './Icons.jsx';

// React owns the shell. The adapter exclusively owns Movi and the status refs inside it.
export function Player({ portals, attentionView, chatOpen = true }) {
  const root = useRef(null);
  const currentState = useRef(null);
  const [liveStream, setLiveStream] = useState(null);
  const [screenState, setScreenState] = useState({ pending: false, local: false, status: '', error: '' });
  const { session, send, system, registerPlayer, attention, state, player } = useRoom();
  const { theme } = useTheme();
  currentState.current = state;
  const isScreen = state.media?.sourceType === 'screen';
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
    const ids = ['video', 'videoShell', 'videoPlaceholder', 'hostControls', 'chooseVideoButton', 'viewerControls', 'fullscreenButton', 'roleBadge', 'fileName', 'syncStatus', 'fileSharingStatus'];
    const elements = Object.fromEntries(ids.map(id => [id, node.querySelector(`#${id}`)]));
    elements.placeholderTitle = elements.videoPlaceholder.querySelector('strong');
    elements.placeholderText = elements.videoPlaceholder.querySelector('span:last-child');
    Object.assign(elements, { theaterRoot: node.closest('.watch-theater'), chatConversation: portals.chat, chatMessages: portals.chat.querySelector('#chatMessages'), floatingReactions: portals.floating, reactionFeed: portals.feed, emojiPicker: portals.overlays, messageMenu: portals.menu });
    const files = createHostFiles({ send, report: system });
    const controller = createPlayer({ elements, state: session.current, send, report: system, files, attention: attention.current, onScreenQuality: value => screenShare.setQuality(value) });
    let disposed = false;
    const screenShare = createScreenShare({ send, getState: () => currentState.current, getClientId: () => session.current.clientId,
      onStream: (stream, local) => { if (!disposed) setLiveStream(previous => !stream ? null : previous?.stream === stream && previous.local === local ? previous : { stream, local }); },
      onChange: value => { if (!disposed) { setScreenState(previous => ({ ...previous, ...value })); if (Object.hasOwn(value, 'quality')) controller.setScreenQuality(value.quality); } } });
    const controls = event => attention.current?.controlsChange(event.detail.visible);
    elements.video.addEventListener('controlschange', controls);
    registerPlayer({ files, controller, screenShare });
    return () => { disposed = true; registerPlayer(null); screenShare.destroy(); elements.video.removeEventListener('controlschange', controls); controller.destroy(); };
  }, [session, send, system, registerPlayer, attention, portals]);
  useEffect(() => { player.current?.controller.setChatVisible(chatOpen); }, [chatOpen, player]);
  useEffect(() => {
    player.current?.controller.setScreenStream(isScreen ? liveStream?.stream || null : null, Boolean(liveStream?.local));
  }, [isScreen, liveStream, player]);
  return <section ref={root} className="player-panel" aria-labelledby="player-title">
    <h2 id="player-title" className="sr-only">Shared video</h2>
    <div className="watch-media-bar"><div className="watch-media-title"><h3 id="fileName">No video selected</h3>{hasVideo && <p className="watch-playback-summary">{isScreen ? (providing ? 'Sharing your screen live' : 'Live screen share') : state.role === 'host' ? 'You control shared playback' : can(state, 'playPause') ? 'Play and pause are shared with the room' : 'Playback is controlled by the host'}</p>}</div>
      <div className="watch-media-actions"><div id="hostControls" className="host-controls" hidden><Button id="chooseVideoButton" disabled={screenState.pending} variant={hasVideo ? 'secondary' : 'primary'}><Icon name={hasVideo ? 'video' : 'plus'} />{hasVideo ? 'Replace video' : 'Choose video'}</Button></div>
      {(can(state, 'chooseVideo') || screenState.local || isScreen && providing) && <Button id="shareScreenButton" variant={screenState.local ? 'danger' : 'secondary'} pending={screenState.pending} pendingLabel="Choosing screen…" disabled={!state.connected} onClick={() => screenState.local ? player.current?.screenShare.stop() : player.current?.screenShare.start()}><Icon name="screen" />{screenState.local ? 'Stop sharing' : 'Share screen'}</Button>}</div>
      <span id="roleBadge" className="sr-only" aria-hidden="true">Viewer</span>
    </div>
    {screenState.error && <div className="watch-screen-feedback"><Status tone="error">{screenState.error}</Status>{isScreen && !providing && <Button onClick={() => player.current?.screenShare.retry()}>Retry screen share</Button>}</div>}
    <div id="videoShell" className="video-shell">
      <movi-player id="video" playsinline="" preload="auto" engine="native wasm" wasmurl="/vendor/movi.wasm" smoothwarning="" theme={theme} objectfit="contain" titlemode="fullscreen">Your browser does not support the WatchParty player.</movi-player>
      <div id="videoPlaceholder" className="video-placeholder"><span className="placeholder-icon" aria-hidden="true"><Icon name="video" /></span><strong>Waiting for the host</strong><span>The host will choose a video file and start the watch party.</span></div>
      <div id="viewerControls" className="viewer-controls" hidden><button id="fullscreenButton" className="fullscreen-button" type="button" aria-label="Enter fullscreen" title="Fullscreen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /></svg></button></div>
      {attentionView.playbackBlocked && state.connected && state.media?.hasVideo && <Button className="watch-join-playback" variant="primary" onClick={() => player.current?.controller.retryPlayback()}>Join playback</Button>}
    </div>
    {state.role === 'host' && hasVideo && providing && <p className="watch-sharing-status">Sharing from this browser. Keep it open while everyone watches.</p>}
    <details className="watch-player-help"><summary>Playback &amp; sharing details</summary><p id="syncStatus" className="sync-status">Waiting for host</p>{can(state, 'chooseVideo') && <p>Choose a video file or share a screen, window, or browser tab. For screen-share sound, enable audio in the browser picker if offered. Keep this browser open while sharing. File captions and quality controls are in the player.</p>}</details>
    <p id="fileSharingStatus" className="watch-sharing-status" hidden>You are sharing this video. Keep this browser open while everyone watches.</p>
  </section>;
}
