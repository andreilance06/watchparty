const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserDouble } = require('./helpers/browser');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

async function setup(options) {
  const browser = createBrowserDouble(options);
  const { createSubtitles } = await browser.load('js/player/subtitles.js');
  const video = browser.elements.get('video'), errors = [];
  const subtitles = createSubtitles({ elements: { video }, report: error => errors.push(error) });
  const notice = () => video.overlays.get('watchparty-caption-status')?.content.querySelector('.watchparty-caption-status-text').textContent;
  subtitles.setAvailability({ hasVideo: true });
  const menuStatus = () => video.shadowRoot.querySelector('.movi-subtitle-track-list').querySelector('.watchparty-caption-status-text').textContent;
  return { browser, video, subtitles, errors, notice, menuStatus };
}

test('caption status waits for content, fonts, and the worker while playback starts independently', async () => {
  const worker = deferred(), content = deferred(), font = deferred();
  const b = await setup({ rendererReady: worker.promise });
  const fetch = b.browser.context.fetch;
  b.browser.context.fetch = async url => {
    if (url === '/one.ass') await content.promise;
    if (url === '/font.ttf') await font.promise;
    return fetch(url);
  };
  b.subtitles.setTracks([{ id: 'one', url: '/one.ass', fonts: ['/font.ttf'] }], { reset: true, key: 'one' });
  assert.equal(b.notice(), 'Loading captions and fonts…');
  assert.equal(b.video.overlays.get('watchparty-caption-status').interactive, false);
  assert.equal(b.menuStatus(), 'Loading captions and fonts…');
  const notice = b.video.overlays.get('watchparty-caption-status').content;
  const root = b.video.shadowRoot;
  const list = root.querySelector('.movi-subtitle-track-list');
  const context = root.querySelector('.movi-context-menu-submenu-subtitle');
  const footer = list.querySelector('[role="status"]');
  const spinner = notice.querySelector('.movi-subtitle-pending');
  const button = root.querySelector('.movi-subtitle-track-btn');
  const popup = root.querySelector('.movi-subtitle-track-menu');
  button.click();
  const focused = list.children[1]; focused.focus();
  assert.equal(spinner.getAttribute('aria-hidden'), 'true');
  assert.ok(footer.querySelector('.movi-subtitle-pending'));
  assert.ok(context.querySelector('.movi-subtitle-pending'));
  await b.video.play();
  assert.equal(b.video.paused, false);
  content.resolve(); await flush();
  assert.equal(b.browser.renderers.length, 0, 'font preparation still pending');
  font.resolve(); await flush();
  assert.equal(b.browser.renderers.length, 1);
  assert.equal(b.notice(), 'Starting caption renderer…', 'worker still initializing');
  assert.equal(b.menuStatus(), 'Starting caption renderer…');
  assert.equal(context.querySelector('.watchparty-caption-status-text').textContent, b.menuStatus());
  assert.equal(b.video.overlays.get('watchparty-caption-status').content, notice);
  assert.equal(notice.querySelector('.movi-subtitle-pending'), spinner);
  assert.equal(list.querySelector('[role="status"]'), footer);
  assert.equal(root.querySelector('.movi-subtitle-track-btn'), button);
  assert.equal(b.video.isBottomMenuOpen(popup), true);
  assert.equal(root.activeElement, focused);
  worker.resolve(); await flush();
  assert.equal(b.notice(), 'Captions ready');
  assert.equal(b.menuStatus(), 'Captions ready');
  for (const surface of [notice, footer, context]) assert.equal(surface.querySelector('.movi-subtitle-pending'), null);
  assert.equal(root.activeElement, focused);
  b.browser.runTimers(3000);
  assert.equal(b.notice(), undefined);
  assert.equal(b.menuStatus(), 'Captions ready', 'menu retains current status');
  b.video.currentTime = 12;
  b.video.dispatch('loadeddata'); b.browser.runFrame(); await flush();
  assert.equal(b.browser.renderers[0].lastFrame.mediaTime, 12);
});

test('Off, track changes, and source replacement suppress obsolete completion and failure notices', async () => {
  const b = await setup();
  const old = deferred(), next = deferred();
  const fetch = b.browser.context.fetch;
  b.browser.context.fetch = async url => {
    if (url === '/old.ass') await old.promise;
    if (url === '/next.ass') await next.promise;
    return fetch(url);
  };
  const tracks = [{ id: 'old', url: '/old.ass' }, { id: 'next', url: '/next.ass' }];
  b.subtitles.setTracks(tracks, { reset: true, key: 'one' });
  b.subtitles.select('next');
  old.reject(new Error('Obsolete track')); await flush();
  assert.deepEqual(b.errors, []);
  assert.equal(b.notice(), 'Loading captions and fonts…');
  b.subtitles.select(null);
  next.resolve(); await flush();
  assert.equal(b.notice(), undefined);
  assert.equal(b.menuStatus(), 'Captions off');
  assert.equal(b.video.shadowRoot.querySelector('.movi-subtitle-track-list').querySelector('.movi-subtitle-pending'), null);
  assert.equal(b.browser.renderers.length, 0);

  const replacement = deferred();
  b.browser.context.fetch = async url => { if (url === '/source.ass') await replacement.promise; return fetch(url); };
  b.subtitles.setTracks([{ id: 'source', url: '/source.ass' }], { reset: true, key: 'two' });
  b.subtitles.setTracks([{ id: 'current', url: '/current.ass' }], { reset: true, key: 'three' });
  await flush(); assert.equal(b.notice(), 'Captions ready');
  replacement.reject(new Error('Obsolete source')); await flush();
  assert.deepEqual(b.errors, []);
  assert.equal(b.subtitles.selectedId(), 'current');
  assert.equal(b.notice(), 'Captions ready');
  b.subtitles.select(null); b.browser.runTimers(3000);
  assert.equal(b.notice(), undefined);
});

test('caption failures leave playback available and a failed track can be retried', async () => {
  const b = await setup(), fetch = b.browser.context.fetch;
  b.browser.context.fetch = async url => url === '/broken.ass' ? { ok: false } : fetch(url);
  b.subtitles.setTracks([{ id: 'broken', url: '/broken.ass' }], { reset: true, key: 'one' });
  await flush();
  assert.equal(b.notice(), 'Could not prepare captions');
  assert.equal(b.menuStatus(), 'Could not prepare captions');
  assert.equal(b.video.overlays.get('watchparty-caption-status').content.querySelector('.movi-subtitle-pending'), null);
  assert.equal(b.video.shadowRoot.querySelector('.movi-subtitle-track-list').querySelector('.movi-subtitle-pending'), null);
  assert.match(b.errors[0], /Could not load captions/);
  await b.video.play(); assert.equal(b.video.paused, false);
  b.browser.context.fetch = fetch;
  b.subtitles.select('broken'); await flush();
  assert.equal(b.notice(), 'Captions ready');
});

test('a prepared renderer attaches to late and replacement engines without fetching or initializing again', async () => {
  const b = await setup();
  b.subtitles.setTracks([{ id: 'one', url: '/one.ass' }], { reset: true, key: 'one' });
  await flush();
  const renderer = b.browser.renderers[0];
  b.video.player = { setSubtitleRenderer() {} };
  b.video.dispatch('loadedmetadata');
  const adapter = b.video.subtitleRenderer;
  assert.ok(adapter);
  b.video.dispatch('loadeddata');
  b.video.currentTime = 8; b.browser.runFrame(); await flush();
  assert.equal(renderer.lastFrame.mediaTime, 8);
  b.subtitles.sourceChanging();
  b.video.player = { setSubtitleRenderer() {} };
  b.video.dispatch('loadedmetadata'); b.video.dispatch('watchparty-picture-ready');
  b.video.currentTime = 19; b.browser.runFrame(); await flush();
  assert.equal(b.video.subtitleRenderer, adapter);
  assert.equal(b.browser.renderers.length, 1);
  assert.equal(b.browser.requests.filter(r => r.url === '/one.ass').length, 1);
  assert.equal(renderer.lastFrame.mediaTime, 19);
  assert.equal(renderer.destroyed, undefined);
});

test('rejected font loads use the fallback and worker failures never report ready', async () => {
  const worker = deferred(), b = await setup({ rendererReady: worker.promise });
  const fetch = b.browser.context.fetch;
  b.browser.context.fetch = async url => url === '/missing.ttf' ? { ok: false } : fetch(url);
  b.subtitles.setTracks([{ id: 'one', url: '/one.ass', fonts: ['/missing.ttf'] }], { reset: true, key: 'one' });
  await flush();
  assert.equal(b.browser.renderers[0].options.fonts.length, 1);
  worker.reject(new Error('Worker unavailable')); await flush();
  assert.equal(b.notice(), 'Could not prepare captions');
  assert.equal(b.browser.renderers[0].destroyed, true);
  assert.match(b.errors[0], /Worker unavailable/);
});

test('turning captions off during worker startup suppresses late readiness', async () => {
  const worker = deferred(), b = await setup({ rendererReady: worker.promise });
  b.subtitles.setTracks([{ id: 'one', url: '/one.ass' }], { reset: true, key: 'one' });
  await flush();
  assert.equal(b.notice(), 'Starting caption renderer…');
  b.subtitles.select(null);
  assert.equal(b.browser.renderers[0].destroyed, true);
  worker.resolve(); await flush();
  assert.equal(b.notice(), undefined);
  assert.equal(b.menuStatus(), 'Captions off');
  assert.equal(b.video.shadowRoot.querySelector('.movi-subtitle-pending'), null);
  assert.deepEqual(b.errors, []);
});
