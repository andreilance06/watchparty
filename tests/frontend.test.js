const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrowserDouble } = require("./helpers/browser");
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("frontend modules initialize and route playback, captions, fullscreen, chat, and picker actions", async () => {
  const browser = createBrowserDouble();
  await browser.load("js/app.js");
  const socket = browser.sockets[0];
  const el = (id) => browser.elements.get(id);
  assert.equal(browser.document.documentElement.dataset.theme, "dark");
  assert.equal(el("video").getAttribute("theme"), "dark");
  el("themeToggle").dispatch("click");
  assert.equal(browser.document.documentElement.dataset.theme, "light");
  assert.equal(el("video").getAttribute("theme"), "light");
  assert.equal(browser.storage.get("watchparty-theme"), "light");
  assert.equal(el("themeToggle").getAttribute("aria-label"), "Switch to dark mode");
  el("themeToggle").dispatch("click");
  assert.equal(browser.document.documentElement.dataset.theme, "dark");
  socket.open();
  assert.equal(socket.sent[0].type, "join");
  assert.equal(el("connectionStatus").textContent, "Connected");
  socket.receive({ type: "role", role: "host", clientId: "host-id", name: "Host", viewerCount: 1 });
  assert.equal(el("hostControls").hidden, false);
  assert.equal(el("displayNameInput").value, "Host");
  socket.receive({
    type: "session-state", hasVideo: true, paused: true, time: 8, playbackRate: 1,
    fileName: "movie.mkv", mediaUrl: "/hls/master.m3u8?v=1", syncMode: "source",
    captions: [{ url: "/hls/captions_0.ass?v=1", label: "English", lang: "eng", format: "ass" }]
  });
  el("video").readyState = 4;
  el("video").dispatch("loadeddata");
  await flush();
  assert.equal(el("videoPlaceholder").hidden, true);
  assert.equal(el("video").currentTime, 8);
  assert.equal(el("video").customControls.get("watchparty-captions").items.length, 2);
  assert.ok(browser.renderers[0].options.subContent.includes("[Events]"));
  assert.equal(el("video").children.find((item) => item.tagName === "source").src, "/hls/master.m3u8?v=1");
  browser.runFrame();
  await flush();
  assert.equal(browser.renderers[0].lastFrame.mediaTime, 8);
  el("fullscreenButton").dispatch("click");
  await flush();
  assert.equal(browser.document.fullscreenElement, el("videoShell"));
  assert.equal(el("video").fullscreenUiActive, true);
  el("video").customControls.get("watchparty-captions").onPick("off");
  await flush();
  assert.equal(browser.renderers[0].destroyed, true);

  browser.runTimers(400);
  el("chooseVideoButton").dispatch("click");
  await flush();
  const chooser = browser.document.body.children.find((child) => child.type === "file");
  assert.ok(chooser);
  assert.equal(chooser.multiple, true);
  chooser.dispatch("cancel");
  assert.equal(browser.requests.filter((request) => request.options?.method === "POST").length, 0, "Opening/cancelling the picker never calls the server native picker");
  el("chatInput").value = "  Hi  ";
  el("chatForm").dispatch("submit");
  assert.equal(socket.sent.at(-1).message, "Hi");
  el("reactLove").dispatch("click");
  assert.deepEqual(socket.sent.at(-1), { type: "reaction", emoji: "❤️" });
  socket.receive({ type: "reaction", clientId: "host-id", name: "Host", emoji: "❤️" });
  assert.equal(el("reactionFeed").children[0].textContent, "❤️ Host");
  el("suggestionInput").value = "  The   Next Movie ";
  el("suggestionForm").dispatch("submit");
  assert.deepEqual(socket.sent.at(-1), { type: "suggest-video", title: "The Next Movie" });
  socket.receive({
    type: "party-state",
    myVoteId: 2,
    participants: [
      { clientId: "host-id", name: "Host", role: "host" },
      { clientId: "viewer-id", name: "Viewer", role: "viewer" }
    ],
    suggestions: [{ id: 2, title: "The Next Movie", votes: 1 }]
  });
  assert.equal(el("participantList").children.length, 2);
  assert.equal(el("voteLeader").textContent, "Leading: The Next Movie (1 vote)");
  const voteButton = el("voteOptions").children[0].children[1];
  assert.equal(voteButton.getAttribute("aria-pressed"), "true");
  assert.equal(voteButton.disabled, true);
  assert.equal(el("voteStatus").textContent, "1 vote cast");
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
  assert.equal(el("video").customControls.has("watchparty-captions"), false);
});

test("voting uses party-state for counts, ties, selections, and replaceable votes", async () => {
  const browser = createBrowserDouble();
  await browser.load("js/app.js");
  const socket = browser.sockets[0];
  const el = (id) => browser.elements.get(id);
  socket.open();
  assert.equal(el("voteLeader").textContent, "No suggestions yet.");
  assert.equal(el("voteStatus").textContent, "0 votes cast");
  assert.equal(el("voteOptions").children[0].textContent, "Suggest a title to start voting.");
  const sent = socket.sent.length;
  el("suggestionInput").value = "   ";
  el("suggestionForm").dispatch("submit");
  assert.equal(socket.sent.length, sent);

  const suggestions = [{ id: 1, title: "Arrival", votes: 0 }, { id: 2, title: "Moonlight", votes: 0 }];
  socket.receive({ type: "party-state", suggestions, myVoteId: null });
  assert.equal(el("voteLeader").textContent, "No votes yet.");
  el("voteOptions").children[0].children[1].dispatch("click");
  assert.deepEqual(socket.sent.at(-1), { type: "vote-video", suggestionId: 1 });

  suggestions[0].votes = 2;
  suggestions[1].votes = 1;
  socket.receive({ type: "party-state", suggestions, myVoteId: 1 });
  assert.equal(el("voteStatus").textContent, "3 votes cast");
  assert.equal(el("voteLeader").textContent, "Leading: Arrival (2 votes)");
  let rows = el("voteOptions").children;
  assert.equal(rows[0].children[0].children[1].textContent, "2 votes · 67%");
  assert.equal(rows[0].children[0].children[2].children[0].style.width, "67%");
  assert.equal(rows[0].children[1].disabled, true);
  assert.equal(rows[1].children[1].disabled, false);
  rows[1].children[1].dispatch("click");
  assert.deepEqual(socket.sent.at(-1), { type: "vote-video", suggestionId: 2 });

  suggestions[0].votes = 1;
  suggestions[1].votes = 2;
  socket.receive({ type: "party-state", suggestions, myVoteId: 2 });
  rows = el("voteOptions").children;
  assert.equal(rows[0].children[1].getAttribute("aria-pressed"), "false");
  assert.equal(rows[0].children[1].disabled, false);
  assert.equal(rows[1].children[1].getAttribute("aria-pressed"), "true");
  assert.equal(rows[1].children[1].disabled, true);

  suggestions[1].votes = 1;
  socket.receive({ type: "party-state", suggestions, myVoteId: null });
  assert.equal(el("voteLeader").textContent, "Tie: Arrival, Moonlight (1 vote each)");
  assert.equal(el("voteOptions").children[0].children[0].children[2].children[0].style.width, "50%");
  const title = '<img src=x onerror="alert(1)">';
  socket.receive({ type: "party-state", suggestions: [{ id: 3, title, votes: 0 }] });
  assert.equal(el("voteOptions").children[0].children[0].children[0].textContent, title);
  assert.equal(el("voteOptions").children[0].children[0].children[0].children.length, 0);
});

test("participant updates and bounded reactions render through the combined app", async () => {
  const browser = createBrowserDouble();
  await browser.load("js/app.js");
  const socket = browser.sockets[0];
  socket.receive({ type: "presence", count: 1, participants: [{ name: "New Host", role: "host" }] });
  assert.equal(browser.elements.get("viewerCount").textContent, "1 online");
  const participant = browser.elements.get("participantList").children[0];
  assert.equal(participant.children[1].textContent, "New Host");
  assert.equal(participant.children[2].textContent, "Host");
  for (let i = 0; i < 7; i++) socket.receive({ type: "reaction", emoji: "👏", name: `Guest ${i}` });
  const feed = browser.elements.get("reactionFeed").children;
  assert.equal(feed.length, 5);
  assert.equal(feed[0].textContent, "👏 Guest 2");
  assert.equal(feed[4].textContent, "👏 Guest 6");
});

test("a saved light theme is restored for the page and player", async () => {
  const browser = createBrowserDouble();
  browser.storage.set("watchparty-theme", "light");
  await browser.load("js/app.js");
  assert.equal(browser.document.documentElement.dataset.theme, "light");
  assert.equal(browser.elements.get("video").getAttribute("theme"), "light");
  assert.equal(browser.elements.get("themeToggle").getAttribute("aria-pressed"), "true");
});

for (const storageFailure of ["access", "read", "write"]) {
  test(`storage ${storageFailure} failures allow startup, theme switching, and joining`, async () => {
    const browser = createBrowserDouble({ storageFailure });
    await browser.load("js/app.js");
    assert.equal(browser.document.documentElement.dataset.theme, "dark");
    browser.elements.get("themeToggle").dispatch("click");
    assert.equal(browser.document.documentElement.dataset.theme, "light");
    assert.equal(browser.elements.get("video").getAttribute("theme"), "light");
    assert.equal(browser.elements.get("themeToggle").getAttribute("aria-label"), "Switch to dark mode");
    browser.sockets[0].open();
    assert.equal(browser.sockets[0].sent[0].type, "join");
    browser.sockets[0].receive({ type: "role", role: "host", clientId: "host", name: "Host", viewerCount: 1 });
    assert.equal(browser.elements.get("hostControls").hidden, false);
  });
}

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

test("browser host serves exact file ranges and caption controls use the active source", async () => {
  const browser = createBrowserDouble();
  const { createHostFiles } = await browser.load("js/host-files.js");
  const sent = [], errors = [];
  const files = createHostFiles({ send: (message) => { sent.push(message); return true; }, report: (message) => errors.push(message) });
  files.setRole("host");
  files.chooseVideo();
  let chooser = browser.document.body.children.at(-1);
  const video = new File(["0123456789"], "movie.mkv");
  const caption = new File(["caption bytes"], "movie.srt");
  chooser.files = [video, caption];
  chooser.dispatch("change");
  await flush();
  const registration = sent.at(-1);
  assert.equal(registration.type, "source-register");
  assert.equal(registration.video.name, "movie.mkv");
  assert.equal(registration.captions.length, 1);
  assert.notEqual(registration.video.id, registration.captions[0].id);
  assert.equal("bytes" in registration.video, false);
  files.handleMessage({ type: "source-registered", requestId: registration.requestId, sourceId: "source", token: "secret", relayPath: "/rooms/room/source" });
  await flush();
  const socket = browser.sockets[0];
  socket.open();
  assert.equal(socket.url, "ws://localhost:3000/rooms/room/source");
  assert.deepEqual(socket.sent[0], { type: "source-attach", sourceId: "source", token: "secret" });
  socket.receive({ type: "source-read", requestId: 7, fileId: registration.video.id, offset: 3, length: 4 });
  await flush();
  const frame = socket.sent.at(-1);
  assert.equal(new DataView(frame.buffer).getUint32(0), 7);
  assert.equal(Buffer.from(frame.subarray(4)).toString(), "3456");
  socket.receive({ type: "source-read", requestId: 8, fileId: registration.video.id, offset: 9, length: 100 });
  await flush();
  assert.deepEqual(socket.sent.at(-1), { type: "source-error", requestId: 8 });
  files.chooseVideo();
  browser.document.body.children.at(-1).dispatch("cancel");
  assert.equal(socket.readyState, 1, "Cancelling another chooser preserves the current source");

  files.chooseCaptions();
  chooser = browser.document.body.children.at(-1);
  chooser.files = [new File(["new captions"], "extra.ass")];
  chooser.dispatch("change");
  await flush();
  const addition = sent.at(-1);
  assert.equal(addition.type, "captions-add");
  assert.equal(addition.sourceId, "source");
  files.handleMessage({ type: "captions-managed", requestId: addition.requestId });
  await flush();
  const removal = files.removeCaption("track-id");
  assert.equal(sent.at(-1).type, "caption-remove");
  assert.equal(sent.at(-1).trackId, "track-id");
  files.handleMessage({ type: "captions-managed", requestId: sent.at(-1).requestId });
  await removal;
  files.chooseVideo();
  chooser = browser.document.body.children.at(-1);
  chooser.files = [new File(["abcdef"], "replacement.mp4")];
  chooser.dispatch("change");
  await flush();
  const replacement = sent.at(-1);
  assert.equal(socket.readyState, 1, "Register replacement before closing the old relay");
  files.handleMessage({ type: "source-registered", requestId: replacement.requestId, sourceId: "next-source", token: "next-token", relayPath: "/rooms/room/source" });
  await flush();
  assert.equal(socket.readyState, 3);
  const nextSocket = browser.sockets[1];
  nextSocket.open();
  files.handleMessage({ type: "source-release-file", sourceId: "source", fileId: replacement.video.id });
  nextSocket.receive({ type: "source-read", requestId: 1, fileId: replacement.video.id, offset: 0, length: 3 });
  await flush();
  assert.equal(Buffer.from(nextSocket.sent.at(-1).subarray(4)).toString(), "abc", "A stale release cannot discard a new source's file");
  files.setRole("viewer");
  assert.equal(nextSocket.readyState, 3);
  assert.deepEqual(errors, []);
});

test("live caption edits preserve viewer choice and playback without recreating the source", async () => {
  const browser = createBrowserDouble();
  await browser.load("js/app.js");
  const socket = browser.sockets[0];
  const el = (id) => browser.elements.get(id);
  socket.open();
  socket.receive({ type: "role", role: "host", clientId: "host", name: "Host", viewerCount: 1 });
  const first = { id: "first", url: "/hls/captions_0.ass?v=1", label: "First", format: "ass" };
  const second = { id: "second", url: "/hls/captions_1.ass?v=1", label: "Second", format: "ass" };
  socket.receive({ type: "session-state", mediaVersion: 1, hasVideo: true, paused: false, time: 17, playbackRate: 1,
    mediaUrl: "/hls/master.m3u8?v=1", captions: [first], fileName: "movie.mkv" });
  el("video").dispatch("loadeddata");
  await flush();
  const source = el("video").children.find((item) => item.tagName === "source");
  const renderer = browser.renderers[0];
  const time = el("video").currentTime;
  const paused = el("video").paused;
  socket.receive({ type: "captions-updated", mediaVersion: 1, captions: [second, first] });
  await flush();
  assert.equal(el("video").customControls.get("watchparty-captions").value, "first");
  assert.equal(browser.renderers.length, 1);
  assert.equal(renderer.destroyed, undefined);
  assert.equal(el("video").children.find((item) => item.tagName === "source"), source);
  assert.equal(el("video").currentTime, time);
  assert.equal(el("video").paused, paused);
  socket.receive({ type: "captions-updated", mediaVersion: 0, captions: [] });
  assert.equal(el("video").customControls.get("watchparty-captions").value, "first", "Stale updates cannot remove current captions");
  socket.receive({ type: "captions-updated", mediaVersion: 1, captions: [second] });
  await flush();
  assert.equal(el("video").customControls.get("watchparty-captions").value, "off");
  assert.equal(renderer.destroyed, true);
  assert.equal(el("removeCaptionButton").disabled, true);
  socket.receive({ type: "captions-updated", mediaVersion: 1, captions: [second, first] });
  assert.equal(el("video").customControls.get("watchparty-captions").value, "off", "Adding captions preserves Off");
  assert.equal(el("video").children.find((item) => item.tagName === "source"), source);
});

test("a replaced browser tab does not reconnect and displace the new connection", async () => {
  const browser = createBrowserDouble();
  const { createConnection } = await browser.load("js/connection.js");
  const status = [];
  const connection = createConnection({ getIdentity: () => ({}), onMessage() {}, onStatus: (_, message) => status.push(message) });
  connection.connect();
  browser.sockets[0].dispatch("close", { code: 4000 });
  browser.runTimers(1500);
  assert.equal(browser.sockets.length, 1);
  assert.equal(status.at(-1), "Connected in another tab");
});
