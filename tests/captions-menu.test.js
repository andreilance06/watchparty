const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserDouble } = require('./helpers/browser');

async function setup() {
  const browser = createBrowserDouble();
  const { createSubtitles } = await browser.load('js/player/subtitles.js');
  const video = browser.elements.get('video');
  const subtitles = createSubtitles({ elements: { video }, report() {} });
  const tracks = [{ id: 'english', label: 'English', url: '/english.ass' }];
  subtitles.setTracks(tracks, { reset: true, key: 'source-1' });
  const toggle = () => video.customControls.get('watchparty-captions').onSelect();
  const visible = () => video.isOverlayVisible('watchparty-caption-menu');
  const panel = () => video.overlays.get('watchparty-caption-menu').content;
  function dispatch(type, path, extra = {}) {
    const result = { prevented: false, stopped: false };
    browser.document.dispatch(type, { composedPath: () => path,
      preventDefault: () => { result.prevented = true; },
      stopPropagation: () => { result.stopped = true; }, ...extra });
    return result;
  }
  return { browser, video, subtitles, tracks, toggle, visible, panel, dispatch };
}

test('caption icon toggles its panel, and picture clicks/taps dismiss without changing selection or playback', async () => {
  const b = await setup();
  const control = b.video.customControls.get('watchparty-captions');
  assert.match(control.icon, /<svg/); assert.equal(control.label, 'Captions'); assert.equal(control.title, 'Captions');
  b.toggle(); assert.equal(b.visible(), true);
  const trigger = { dataset: { customControl: 'watchparty-captions' } };
  b.dispatch('click', [trigger, b.video]); assert.equal(b.visible(), true, 'the opening/trigger click is left to the button');
  b.toggle(); assert.equal(b.visible(), false);
  for (const event of ['click', 'touchend']) {
    b.toggle();
    b.dispatch(event, [b.panel().children[1], b.panel(), b.video]);
    assert.equal(b.visible(), true, 'inside interactions do not dismiss the panel prematurely');
    const result = b.dispatch(event, [b.browser.document.createElement('canvas'), b.video]);
    assert.equal(b.visible(), false); assert.equal(result.prevented, true); assert.equal(result.stopped, true);
    assert.equal(b.subtitles.selectedId(), 'english'); assert.equal(b.video.paused, true);
  }
  b.toggle();
  const otherControl = { matches: () => true };
  const result = b.dispatch('click', [otherControl, b.video]);
  assert.equal(b.visible(), false); assert.equal(result.stopped, false, 'other player controls keep their action');
  b.toggle();
  b.dispatch('click', [b.browser.document.body]); assert.equal(b.visible(), false);
  b.toggle(); b.dispatch('keydown', [b.video], { key: 'Escape' });
  assert.equal(b.visible(), false); assert.equal(b.video.focused, true);
});

test('caption dismissal cleans listeners and follows option selection, source replacement, and live track edits', async () => {
  const b = await setup();
  const count = () => ['click', 'touchend', 'keydown'].map(type => (b.browser.document.listeners.get(type) || []).length);
  const baseline = count();
  for (let i = 0; i < 3; i++) {
    b.toggle(); assert.deepEqual(count(), baseline.map(n => n + 1));
    b.video.hideOverlay('watchparty-caption-menu'); assert.deepEqual(count(), baseline);
  }
  b.toggle(); b.panel().children[0].click();
  assert.equal(b.subtitles.selectedId(), null); assert.equal(b.visible(), false); assert.deepEqual(count(), baseline);
  b.toggle();
  b.subtitles.setTracks([...b.tracks, { id: 'french', label: 'French', url: '/french.ass' }]);
  assert.equal(b.panel().children.length, 3); assert.equal(b.subtitles.selectedId(), null);
  b.subtitles.setTracks(b.tracks, { key: 'source-2' });
  assert.equal(b.visible(), false); assert.deepEqual(count(), baseline);
  b.toggle(); b.subtitles.setTracks([]);
  assert.equal(b.visible(), false); assert.equal(b.video.customControls.has('watchparty-captions'), false);
  assert.deepEqual(count(), baseline);
});
