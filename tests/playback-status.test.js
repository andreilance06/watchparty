const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrowserDouble } = require("./helpers/browser");

test("caption and quality rows share one accessible card with independent timers", async () => {
  const b = createBrowserDouble(), video = b.elements.get("video");
  const { createPlaybackStatus } = await b.load("js/player/playback-status.js");
  const status = createPlaybackStatus(video);
  status.set("captions", { text: "Loading captions", pending: true });
  const card = video.overlays.get("watchparty-playback-status").content;
  status.set("quality", { text: "Checking connection speed...", pending: true });
  assert.equal(video.overlays.size, 1); assert.equal(card.children.length, 2);
  assert.equal(card.getAttribute("role"), "status");
  assert.equal(card.querySelectorAll(".movi-subtitle-pending").length, 2);
  status.set("quality", { text: "Using 720p quality" });
  b.runTimers(3000);
  assert.equal(card.children.length, 1);
  assert.equal(card.children[0].dataset.statusChannel, "captions");
  status.set("captions", { text: "Captions ready" });
  b.runTimers(3000); assert.equal(video.overlays.size, 0);
  status.set("quality", { text: "Adjusting quality...", pending: true });
  status.destroy(); b.runTimers(3000); assert.equal(video.overlays.size, 0);
});

test("replaced rows cancel old dismissal timers and repeated updates do not prolong a completed notice", async () => {
  const b = createBrowserDouble(), video = b.elements.get("video");
  const { createPlaybackStatus } = await b.load("js/player/playback-status.js");
  const status = createPlaybackStatus(video);
  status.set("quality", { text: "Connection speed checked" });
  const timer = [...b.timers.keys()].at(-1);
  status.set("quality", { text: "Connection speed checked" });
  assert.equal([...b.timers.keys()].at(-1), timer);
  status.set("quality", { text: "Adjusting quality...", pending: true });
  b.runTimers(3000); assert.equal(video.overlays.size, 1);
  status.clearAll(); assert.equal(video.overlays.size, 0);
});
