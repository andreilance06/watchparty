const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserDouble } = require('./helpers/browser');

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
