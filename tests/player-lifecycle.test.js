const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserDouble } = require('./helpers/browser');

test('live Settings exposes working aspect choices and restores native hooks on disposal', async () => {
  const b = createBrowserDouble(), video = b.elements.get('video');
  const { createLiveStreamPlayback } = await b.load('js/player/live-stream.js');
  let aspectDisabled = false, fit = 'contain', updates = 0;
  video.video = b.document.createElement('video');
  video.isControlDisabled = () => aspectDisabled;
  const available = video.isControlAvailable = () => false;
  const updateFit = video.updateFitMode = () => { updates++; };
  video.posterObjectFit = () => fit;
  const live = createLiveStreamPlayback({ video, isActive: () => true, onReady() {}, onWaiting() {} });
  live.setStream({}, true);
  assert.equal(video.isControlAvailable('aspect'), true);
  assert.equal(video.isControlAvailable('hdr'), false);
  assert.equal(video.video.style.objectFit, 'contain');
  fit = 'cover'; video.updateFitMode();
  assert.equal(video.video.style.objectFit, 'cover'); assert.equal(updates, 2);
  aspectDisabled = true; assert.equal(video.isControlAvailable('aspect'), false);
  live.detach(); assert.equal(video.isControlAvailable('aspect'), false);
  live.destroy();
  assert.equal(video.isControlAvailable, available); assert.equal(video.updateFitMode, updateFit);
});

test('Movi renders live streams with local controls, no seeking/rate, and survives host transfer', async () => {
  const browser = createBrowserDouble();
  const { getElements } = await browser.load('js/dom.js');
  const { createPlayer } = await browser.load('js/player/controller.js');
  const elements = getElements(), session = { role: 'host', clientId: 'self' };
  const originalSourceCheck = elements.video.hasMediaSource = () => Boolean(session.activeMediaUrl);
  const sent = [];
  const controller = createPlayer({ elements, state: session, send: message => sent.push(message), report() {}, files: { setRole() {}, chooseVideo() {}, chooseCaptions() {}, disconnect() {} } });
  const live = { sessionId: 'screen-room', sourceId: 'screen1', sourceType: 'screen', sourceOwnerId: 'self', mediaVersion: 1, playbackRevision: 0, hasVideo: true, paused: false, fileName: 'Shared tab' };
  controller.applySessionState(live);
  assert.equal(session.activeMediaUrl, ''); assert.equal(elements.fileName.textContent, 'Shared tab');
  assert.equal(elements.viewerControls.hidden, true); assert.equal(elements.videoPlaceholder.hidden, false);
  const stream = { getTracks() { throw new Error('The player must not own capture tracks'); } };
  elements.video.playbackRate = 2; elements.video.loop = true;
  controller.setScreenStream(stream, true);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(elements.video.srcObject, stream);
  assert.equal(elements.video.hasMediaSource(), true);
  assert.equal(elements.video.muted, true); assert.equal(elements.video.playbackRate, 1); assert.equal(elements.video.loop, false);
  assert.equal(elements.video.controls, true); assert.equal(elements.video.style.visibility, '');
  assert.equal(elements.videoPlaceholder.hidden, true);
  for (const flag of ['noseekbuttons', 'noprogress', 'notimeline', 'nochapters', 'nospeed', 'notime', 'nowatchparty-playback-rate']) assert.ok(elements.video.getAttribute('controlslist').split(' ').includes(flag));
  assert.equal(elements.video.getAttribute('fastseek'), 'false');
  assert.equal(elements.video.getAttribute('nohotkeys'), '');
  const seek = elements.video.dispatch('watchparty-seek-intent', { detail: { time: 12 } });
  assert.equal(seek.defaultPrevented, true);
  elements.video.playbackRate = 2; elements.video.dispatch('ratechange');
  assert.equal(elements.video.playbackRate, 1);
  elements.video.pause(); await elements.video.play();
  for (const timer of browser.timers.values()) if (timer.interval && timer.delay === 2000) timer.fn();
  assert.equal(sent.length, 0);
  controller.applyRole('viewer'); controller.applySessionState({ ...live, syncMode: 'host-transfer', playbackRevision: 1 });
  controller.applyRole('host');
  assert.equal(elements.video.srcObject, stream); assert.equal(elements.video.muted, true);
  assert.equal(elements.video.getAttribute('fastseek'), 'false');
  assert.equal(elements.videoPlaceholder.hidden, true); assert.equal(elements.viewerControls.hidden, true);
  controller.applySessionState({ ...live, sourceType: 'file', sourceId: 'file1', mediaVersion: 2, playbackRevision: 2, mediaUrl: '/file.m3u8', duration: 20, time: 0, playbackRate: 1, captions: [] });
  assert.equal(elements.video.srcObject, null);
  assert.equal(elements.video.muted, false);
  assert.equal(session.activeMediaUrl, '/file.m3u8');
  assert.equal(elements.video.getAttribute('controlslist').includes('nospeed'), false);
  assert.equal(elements.video.getAttribute('fastseek'), 'buttons keys gestures');
  assert.equal(elements.video.getAttribute('nohotkeys'), null);
  // A delayed React detach must not unload the replacement file.
  controller.setScreenStream(null);
  assert.equal(session.activeMediaUrl, '/file.m3u8');
  controller.applySessionState({ ...live, sourceType: null, sourceId: null, sourceOwnerId: null, mediaVersion: 3, playbackRevision: 3, hasVideo: false });
  assert.equal(elements.videoPlaceholder.hidden, false); assert.equal(elements.viewerControls.hidden, true);
  controller.destroy();
  assert.equal(elements.video.hasMediaSource, originalSourceCheck);
});

test('live viewer autoplay retry is local and stale play failures cannot block a replacement source', async () => {
  const browser = createBrowserDouble();
  const { getElements } = await browser.load('js/dom.js');
  const { createPlayer } = await browser.load('js/player/controller.js');
  const elements = getElements(), session = { role: 'viewer', clientId: 'viewer' }, blocked = [], sent = [];
  const controller = createPlayer({ elements, state: session, send: message => sent.push(message), report() {}, attention: { setPlaybackBlocked: value => blocked.push(value) }, files: { chooseVideo() {}, chooseCaptions() {}, disconnect() {} } });
  controller.applySessionState({ sourceType: 'screen', sourceId: 'screen1', sourceOwnerId: 'sharer', mediaVersion: 1, playbackRevision: 0, hasVideo: true });
  elements.video.play = async () => { throw new Error('NotAllowedError'); };
  controller.setScreenStream({});
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(blocked.at(-1), true);
  assert.equal(elements.video.muted, false);
  assert.equal(elements.video.getAttribute('controlslist').includes('noplay '), false);
  elements.video.play = async () => { elements.video.paused = false; elements.video.dispatch('play'); };
  controller.retryPlayback();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(blocked.at(-1), false); assert.equal(sent.length, 0);
  let rejectPlay;
  elements.video.play = () => new Promise((resolve, reject) => { rejectPlay = reject; });
  controller.retryPlayback(); await Promise.resolve();
  controller.showNoVideo(); rejectPlay(new Error('late failure'));
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(blocked.at(-1), false); assert.equal(elements.video.srcObject, null);
  controller.destroy();
});

test('theater fullscreen keeps the entire sidebar mounted and restores overlays on exit', async () => {
  const browser = createBrowserDouble();
  const { createFullscreen } = await browser.load('js/player/fullscreen.js');
  const { getElements } = await browser.load('js/dom.js');
  const elements = getElements(), theater = browser.document.createElement('main');
  browser.document.body.appendChild(theater);
  const conversationParent = elements.chatConversation.parentNode;
  theater.appendChild(elements.videoShell); theater.appendChild(conversationParent);
  elements.theaterRoot = theater;
  const overlayParent = elements.emojiPicker.parentNode;
  let requested = false;
  theater.requestFullscreen = async () => { requested = true; browser.document.fullscreenElement = theater; browser.document.dispatch('fullscreenchange'); };
  browser.document.exitFullscreen = async () => { browser.document.fullscreenElement = null; browser.document.dispatch('fullscreenchange'); };
  const snapshots = [];
  const fullscreen = createFullscreen({ elements, getHostPaused: () => true, afterResize() {}, attention: { setFullscreen: state => snapshots.push(state) } });
  elements.chatMessages.scrollTop = 180;
  elements.chatMessages.clientHeight = 0; // A collapsed, still-mounted scroller retains its position.
  fullscreen.setChatVisible(false);
  assert.equal(elements.chatMessages.scrollTop, 180);
  elements.chatMessages.clientHeight = 360;
  await fullscreen.toggle();
  assert.equal(requested, true); assert.equal(snapshots.at(-1).active, true); assert.equal(snapshots.at(-1).chatVisible, false);
  assert.equal(elements.chatConversation.parentNode, conversationParent);
  assert.equal(elements.chatMessages.scrollTop, 180);
  assert.equal(elements.emojiPicker.parentNode, theater);
  fullscreen.setChatVisible(true);
  assert.equal(snapshots.at(-1).chatVisible, true);
  await fullscreen.toggle();
  assert.equal(snapshots.at(-1).active, false);
  assert.equal(elements.chatConversation.parentNode, conversationParent);
  assert.equal(elements.emojiPicker.parentNode, overlayParent);
  theater.requestFullscreen = undefined;
  await fullscreen.toggle();
  assert.equal(theater.classList.contains('pseudo-fullscreen'), true);
  browser.document.dispatch('keydown', { key: 'Escape' });
  assert.equal(theater.classList.contains('pseudo-fullscreen'), false);
  assert.equal(elements.chatConversation.parentNode, conversationParent);
  fullscreen.destroy();
});

test('blocked autoplay exposes a local retry that catches up without broadcasting a room command', async () => {
  const browser = createBrowserDouble();
  const { createPlaybackSync } = await browser.load('js/player/sync.js');
  const video = browser.elements.get('video');
  video.readyState = 2;
  video.play = async () => { throw new Error('NotAllowedError'); };
  const blocked = [], sent = [];
  const sync = createPlaybackSync({ elements: { video, syncStatus: browser.elements.get('syncStatus') }, state: { role: 'viewer' },
    send: message => sent.push(message), attention: { setPlaybackBlocked: value => blocked.push(value) } });
  sync.apply({ paused: false, time: 12, playbackRate: 1, syncMode: 'play' }, false);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.ok(blocked.includes(true));
  assert.match(browser.elements.get('syncStatus').textContent, /Join playback/);
  video.play = async () => { video.paused = false; video.dispatch('play'); };
  sync.retryPlayback();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(blocked.at(-1), false); assert.equal(video.paused, false);
  assert.equal(sent.length, 0); assert.ok(video.currentTime >= 12);
  sync.destroy();
});

test('React media adapter cleanup removes repeaters, listeners, hooks, and relays across remounts', async () => {
  const browser = createBrowserDouble();
  const { getElements } = await browser.load('js/dom.js');
  const { createPlayer } = await browser.load('js/player/controller.js');
  const elements = getElements();
  const listeners = target => [...target.listeners.values()].reduce((sum, list) => sum + list.length, 0);
  const before = { document: listeners(browser.document), window: listeners(browser.window), video: listeners(elements.video) };
  const originalQuality = elements.video.updateQualityMenu;
  let disconnected = 0;
  for (let i = 0; i < 2; i++) {
    const controller = createPlayer({ elements, state: { role: 'viewer' }, send: () => true, report() {},
      files: { setRole() {}, chooseVideo() {}, chooseCaptions() {}, disconnect() { disconnected++; } } });
    assert.ok([...browser.timers.values()].filter(timer => timer.interval).length >= 3);
    controller.destroy();
    assert.equal([...browser.timers.values()].filter(timer => timer.interval).length, 0);
    assert.equal(listeners(browser.document), before.document);
    assert.equal(listeners(browser.window), before.window);
    assert.equal(listeners(elements.video), before.video);
    assert.equal(elements.video.updateQualityMenu, originalQuality);
  }
  assert.equal(disconnected, 2);
});
