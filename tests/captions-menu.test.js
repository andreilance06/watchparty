const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserDouble, captionItems, selectedCaption, pickCaption } = require('./helpers/browser');
const flush = () => new Promise(resolve => setImmediate(resolve));

async function setup({ host = false, onAdd, browser = createBrowserDouble() } = {}) {
  const { createSubtitles } = await browser.load('js/player/subtitles.js');
  const video = browser.elements.get('video'), errors = [];
  const subtitles = createSubtitles({ elements: { video }, report: error => errors.push(error), onAddCaptions: onAdd });
  const tracks = [{ id: 'english', title: 'Signs & Songs', label: 'Old label', lang: 'eng', default: true, forced: true, url: '/english.ass' }];
  subtitles.setAvailability({ hasVideo: true, canAdd: host });
  subtitles.setTracks(tracks, { reset: true, key: 'source-1' });
  const root = video.shadowRoot;
  const button = root.querySelector('.movi-subtitle-track-btn');
  const menu = root.querySelector('.movi-subtitle-track-menu');
  const context = root.querySelector('.movi-context-menu-submenu-subtitle');
  return { browser, video, subtitles, tracks, root, button, menu, context, errors };
}

test('native caption surfaces show track names, metadata, Off, and a synchronized Settings summary', async () => {
  const b = await setup();
  assert.equal(b.video.customControls.size, 0);
  assert.equal(b.video.isOverlayVisible('watchparty-caption-menu'), false);
  b.button.click(); assert.equal(b.video.isBottomMenuOpen(b.menu), true);
  assert.equal(b.button.getAttribute('aria-expanded'), 'true');
  const row = captionItems(b.video)[1];
  assert.equal(row.children[1].textContent, 'Signs & Songs');
  assert.equal(row.children[2].textContent, 'eng · Default · Forced');
  assert.equal(row.getAttribute('aria-checked'), 'true');
  assert.equal(b.video.settingsRowValue('subtitles'), 'Signs & Songs');
  assert.equal(b.video.settingsRowValue('aspect'), 'aspect', 'unrelated settings delegate to Movi');
  assert.equal(b.root.querySelector('.movi-subtitle-customize-btn').style.display, 'none');
  pickCaption(b.video, 'off');
  assert.equal(b.subtitles.selectedId(), null);
  assert.equal(selectedCaption(b.video), 'off');
  assert.equal(b.video.settingsRowValue('subtitles'), 'Off');
  assert.equal(b.video.isBottomMenuOpen(b.menu), false);
  assert.equal(b.button.focused, true);
  b.context.children.find(child => child.dataset.roomCaptionId === 'english').click();
  assert.equal(b.subtitles.selectedId(), 'english');
  assert.equal(selectedCaption(b.video), 'english');
});

test('status and track updates preserve the native trigger, open menu, and focused row', async () => {
  const b = await setup();
  b.button.click();
  const focused = captionItems(b.video)[1]; focused.focus();
  await flush();
  assert.equal(b.root.querySelector('.movi-subtitle-track-list').querySelector('.watchparty-caption-status-text').textContent, 'Captions ready');
  b.video.dispatch('loadedmetadata');
  b.subtitles.setTracks([...b.tracks, { id: 'french', label: 'French', url: '/french.ass' }]);
  assert.equal(b.root.querySelector('.movi-subtitle-track-btn'), b.button);
  assert.equal(b.video.isBottomMenuOpen(b.menu), true);
  assert.equal(captionItems(b.video)[1], focused);
  assert.equal(b.root.activeElement, focused);
  b.video.hideControls(); assert.equal(b.root.classList.contains('hidden-controls'), false);
  assert.equal(b.subtitles.selectedId(), 'english');
  b.subtitles.setTracks(b.tracks, { key: 'source-2' });
  assert.equal(b.video.isBottomMenuOpen(b.menu), false);
  b.video.hideControls(); assert.equal(b.root.classList.contains('hidden-controls'), true);
  b.subtitles.setTracks([]);
  assert.equal(b.button.disabled, true);
  b.subtitles.setAvailability({ canAdd: true });
  assert.equal(b.button.disabled, false, 'hosts can add the first track');
});

test('native rows support keyboard selection, navigation, and Escape dismissal', async () => {
  const b = await setup();
  b.button.click();
  const rows = captionItems(b.video);
  b.root.dispatch('keydown', { target: b.button, key: 'ArrowUp' });
  assert.equal(b.root.activeElement, rows[1]);
  rows[0].dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(b.root.activeElement, rows[1]);
  rows[1].dispatch('keydown', { key: 'Home' });
  assert.equal(b.root.activeElement, rows[0]);
  rows[0].dispatch('keydown', { key: 'Enter' });
  assert.equal(b.subtitles.selectedId(), null);
  assert.equal(b.video.isBottomMenuOpen(b.menu), false);
  b.button.click(); rows[0].dispatch('keydown', { key: 'Escape' });
  assert.equal(b.video.isBottomMenuOpen(b.menu), false);
  assert.equal(b.button.getAttribute('aria-expanded'), 'false');
  b.video.dispatch('keydown', { key: 'v' }); assert.equal(b.subtitles.selectedId(), 'english');
  b.video.dispatch('keydown', { key: 'v' }); assert.equal(b.subtitles.selectedId(), null);
  b.video.setAttribute('nohotkeys', '');
  b.video.dispatch('keydown', { key: 'v' }); assert.equal(b.subtitles.selectedId(), null);
});

test('Add cancellation and processing failures never replace or disable the native CC trigger', async () => {
  const browser = createBrowserDouble();
  const { createHostFiles } = await browser.load('js/host-files.js');
  const sent = [], errors = [];
  const files = createHostFiles({ send: message => { sent.push(message); return true; }, report: error => errors.push(error) });
  files.setRole('host'); files.setSession({ sourceId: 'source-1' });
  const b = await setup({ browser, host: true, onAdd: files.chooseCaptions });
  const add = () => captionItems(b.video).find(row => row.dataset.roomCaptionKey === 'add');
  for (let i = 0; i < 3; i++) {
    b.button.click(); add().click();
    const chooser = browser.document.body.children.at(-1);
    assert.equal(chooser.type, 'file');
    add().click(); assert.equal(browser.document.body.children.at(-1), chooser, 'only one picker opens');
    chooser.dispatch('cancel'); await flush();
    assert.equal(chooser.parentNode, null);
    assert.equal(b.root.querySelector('.movi-subtitle-track-btn'), b.button);
    assert.equal(b.subtitles.selectedId(), 'english');
    b.button.click(); assert.equal(b.video.isBottomMenuOpen(b.menu), true); b.button.click();
  }
  b.button.click(); add().click();
  const invalid = browser.document.body.children.at(-1);
  invalid.files = [new File(['invalid'], 'unsupported.txt')]; invalid.dispatch('change'); await flush();
  assert.match(errors[0], /subtitle files/);
  b.button.click(); assert.equal(b.video.isBottomMenuOpen(b.menu), true);
  assert.equal(sent.length, 0);
  assert.equal(b.subtitles.selectedId(), 'english');
});

test('host transfer revokes Add on both surfaces; disposal restores native methods', async () => {
  let added = 0;
  const b = await setup({ host: true, onAdd: () => added++ });
  const stale = captionItems(b.video).find(row => row.dataset.roomCaptionKey === 'add');
  b.context.children.find(row => row.dataset.roomCaptionKey === 'add').click(); await flush();
  assert.equal(added, 1);
  b.subtitles.setAvailability({ canAdd: false });
  assert.equal(captionItems(b.video).some(row => row.dataset.roomCaptionKey === 'add'), false);
  assert.equal(b.context.children.some(row => row.dataset.roomCaptionKey === 'add'), false);
  stale.click(); assert.equal(added, 1);
  assert.equal(b.subtitles.selectedId(), 'english');
  b.subtitles.destroy();
  assert.equal(b.video.settingsRowValue('subtitles'), 'subtitles');
  assert.equal(b.root.listeners.get('keydown').length, 0);
});

test('pending picker results are ignored after the active source or host changes', async () => {
  const browser = createBrowserDouble();
  const { createHostFiles } = await browser.load('js/host-files.js');
  const sent = [], errors = [];
  const files = createHostFiles({ send: message => { sent.push(message); return true; }, report: error => errors.push(error) });
  files.setRole('host'); files.setSession({ sourceId: 'one' });
  const first = files.chooseCaptions();
  const chooser = browser.document.body.children.at(-1);
  files.setSession({ sourceId: 'two' }); await first;
  chooser.files = [new File(['caption'], 'different-movie.srt')]; chooser.dispatch('change');
  const second = files.chooseCaptions();
  const next = browser.document.body.children.at(-1);
  files.setRole('viewer'); await second;
  next.files = chooser.files; next.dispatch('change'); await flush();
  assert.deepEqual(sent, []); assert.deepEqual(errors, []);
  assert.equal(chooser.parentNode, null); assert.equal(next.parentNode, null);
});

test('picker focus return recovers cancellation when the browser omits its cancel event', async () => {
  const browser = createBrowserDouble();
  const { createHostFiles } = await browser.load('js/host-files.js');
  const files = createHostFiles({ send() {}, report() {} });
  files.setRole('host'); files.setSession({ sourceId: 'source' });
  const pending = files.chooseCaptions();
  const chooser = browser.document.body.children.at(-1);
  browser.window.dispatch('focus'); browser.runTimers(300); await pending;
  assert.equal(chooser.parentNode, null);
  const next = files.chooseCaptions();
  browser.document.body.children.at(-1).dispatch('cancel'); await next;
  assert.equal(browser.window.listeners.get('focus').length, 0);
});
