const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrowserDouble } = require("./helpers/browser");
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("frontend modules initialize and route playback, captions, fullscreen, chat, and picker actions", async () => {
  const browser = createBrowserDouble();
  await browser.load("js/app.js");
  const socket = browser.sockets[0];
  const el = (id) => browser.elements.get(id);
  socket.open();
  assert.equal(socket.sent[0].type, "join");
  assert.equal(el("connectionStatus").textContent, "Connected");
  socket.receive({ type: "role", role: "host", clientId: "host-id", name: "Host", viewerCount: 1 });
  assert.equal(el("hostControls").hidden, false);
  assert.equal(el("displayNameInput").value, "Host");
  socket.receive({
    type: "vote-state", open: true, selectedOptionId: null,
    options: [{ id: "film-1", title: "Arrival", votes: 2 }, { id: "film-2", title: "Moonlight", votes: 1 }]
  });
  assert.equal(el("voteOptions").children.length, 2);
  assert.equal(el("voteStatus").textContent, "3 votes cast");
  el("voteOptions").children[0].children[1].dispatch("click");
  assert.deepEqual(socket.sent.at(-1), { type: "vote", optionId: "film-1" });
  socket.receive({
    type: "vote-state", open: false, selectedOptionId: "film-1",
    options: [{ id: "film-1", title: "Arrival", votes: 3 }]
  });
  assert.equal(el("voteOptions").children[0].children[1].disabled, true);
  assert.equal(el("voteStatus").textContent, "Voting is closed");
  socket.receive({
    type: "session-state", hasVideo: true, paused: true, time: 8, playbackRate: 1,
    fileName: "movie.mkv", mediaUrl: "/hls/master.m3u8?v=1", syncMode: "source",
    captions: [{ url: "/hls/captions_0.ass?v=1", label: "English", lang: "eng", format: "ass" }]
  });
  await flush();
  assert.equal(el("videoPlaceholder").hidden, true);
  assert.equal(el("video").currentTime, 8);
  assert.equal(el("captionControl").hidden, false);
  assert.equal(el("captionSelect").children.length, 2);
  assert.equal(browser.renderers[0].options.subUrl, "/hls/captions_0.ass?v=1");
  assert.equal(el("video").children.find((item) => item.tagName === "source").src, "/hls/master.m3u8?v=1");
  browser.runFrame();
  await flush();
  assert.equal(browser.renderers[0].lastFrame.mediaTime, 8);
  el("fullscreenButton").dispatch("click");
  await flush();
  assert.equal(browser.document.fullscreenElement, el("videoShell"));
  assert.equal(el("video").fullscreenUiActive, true);
  el("captionSelect").value = "-1";
  el("captionSelect").dispatch("change");
  await flush();
  assert.equal(browser.renderers[0].destroyed, true);

  browser.runTimers(400);
  el("chooseVideoButton").dispatch("click");
  await flush();
  assert.equal(JSON.parse(browser.requests[0].options.body).clientId, "host-id");
  el("chatInput").value = "  Hi  ";
  el("chatForm").dispatch("submit");
  assert.equal(socket.sent.at(-1).message, "Hi");
  socket.receive({ type: "name-rejected", name: "Host", message: "Already used" });
  assert.equal(el("displayNameInput").getAttribute("aria-invalid"), "true");

  socket.receive({ type: "role", role: "viewer", clientId: "viewer-id", name: "Viewer", viewerCount: 2 });
  assert.equal(el("hostControls").hidden, true);
  assert.match(el("video").getAttribute("controlslist"), /noprogress/);
  await el("video").play();
  assert.equal(socket.sent.at(-1).syncMode, "play");
  el("video").pause();
  assert.equal(socket.sent.at(-1).syncMode, "pause");
  const sentCount = socket.sent.length;
  el("video").dispatch("seeking");
  assert.equal(socket.sent.length, sentCount);
  socket.receive({ type: "host-left" });
  assert.equal(el("videoPlaceholder").hidden, false);
  assert.equal(el("captionControl").hidden, true);
});

test("connection module reconnects and can be stopped independently", async () => {
  const browser = createBrowserDouble();
  const { createConnection } = await browser.load("js/connection.js");
  const status = [];
  const connection = createConnection({ getIdentity: () => ({ name: "Test" }), onMessage() {}, onStatus: (...args) => status.push(args) });
  connection.connect();
  browser.sockets[0].open();
  browser.sockets[0].close();
  browser.runTimers(1500);
  assert.equal(browser.sockets.length, 2);
  connection.dispose();
  browser.runTimers(1500);
  assert.equal(browser.sockets.length, 2);
  assert.equal(status[0][1], "Connected");
});
