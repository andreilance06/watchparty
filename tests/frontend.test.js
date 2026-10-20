const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrowserDouble } = require("./helpers/browser");
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("emoji picker dismisses, restores focus, tracks its anchor, and preserves insertion selection", async () => {
  const browser = createBrowserDouble();
  await browser.load("js/app.js");
  const el = id => browser.elements.get(id);
  const trigger = el("chatEmojiButton"), picker = el("emojiPicker");
  trigger.getBoundingClientRect = () => ({ top: 700, bottom: 730, right: 990 });
  picker.getBoundingClientRect = () => ({ width: 300, height: 300 });
  trigger.dispatch("click");
  assert.equal(picker.parentNode, browser.document.body);
  assert.equal(picker.style.left, "690px");
  assert.equal(picker.style.top, "392px");
  browser.window.innerWidth = 360;
  browser.window.dispatch("resize");
  assert.equal(picker.style.left, "52px");
  browser.document.dispatch("pointerdown", { composedPath: () => [picker] });
  assert.equal(picker.hidden, false);
  browser.document.dispatch("pointerdown", { composedPath: () => [trigger] });
  trigger.dispatch("click");
  assert.equal(picker.hidden, true);
  trigger.dispatch("click");
  trigger.focused = false;
  browser.document.dispatch("keydown", { key: "Escape", stopPropagation() {} });
  assert.equal(picker.hidden, true);
  assert.equal(trigger.focused, true);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  trigger.dispatch("click");
  browser.document.dispatch("pointerdown", { composedPath: () => [el("chatInput")] });
  assert.equal(picker.hidden, true);
  assert.equal(browser.document.listeners.get("pointerdown").length, 0);
  el("chatInput").value = "Hello world";
  el("chatInput").setSelectionRange(6, 11);
  trigger.dispatch("click");
  el("chatInput").setSelectionRange(0, 0);
  const choice = el("emojiPickerGrid").children[0];
  choice.dispatch("click");
  assert.equal(el("chatInput").value, `Hello ${choice.textContent}`);
  assert.equal(el("chatInput").selectionStart, 6 + choice.textContent.length);
  assert.equal(picker.hidden, true);
});

test("chat retention closes evicted pickers and server snapshots replace optimistic reactions", async () => {
  const browser = createBrowserDouble();
  await browser.load("js/app.js");
  const el = id => browser.elements.get(id), socket = browser.sockets[0];
  socket.open();
  socket.receive({ type: "role", role: "host", clientId: "host", name: "Host" });
  const add = i => socket.receive({ type: "chat", commentId: `comment-${i}`, name: "Host", message: String(i) });
  add(0);
  const first = el("chatMessages").children.at(-1), bar = first.children[2];
  socket.receive({ type: "comment-reaction", commentId: "comment-0", reactions: [
    { clientId: "host", name: "Host", emoji: "❤️" }, { clientId: "viewer", name: "Viewer", emoji: "❤️" }
  ] });
  const heart = bar.children[0];
  assert.equal(heart.children[1].textContent, "2");
  assert.match(heart.getAttribute("aria-label"), /your reaction/);
  heart.dispatch("click");
  assert.equal(socket.sent.at(-1).emoji, null);
  socket.receive({ type: "comment-reaction", commentId: "comment-0", reactions: [] });
  assert.equal(bar.children.length, 2);
  bar.children[0].dispatch("click");
  assert.equal(el("emojiPicker").hidden, false);
  for (let i = 1; i <= 500; i++) add(i);
  assert.equal(first.parentNode, null);
  assert.equal(el("emojiPicker").hidden, true);
  assert.equal(el("chatMessages").children.filter(child => child.classList.contains("chat-message")).length, 500);
  socket.receive({ type: "comment-reaction", commentId: "comment-0", reactions: [{ clientId: "host", emoji: "❤️" }] });
  assert.equal(bar.children.length, 2, "Evicted comment snapshots are ignored");
});

test("reaction bursts stay bounded, clean up, and respect reduced motion", async () => {
  const browser = createBrowserDouble();
  let motionChange;
  const motion = { matches: false, addEventListener: (_, fn) => { motionChange = fn; } };
  browser.window.matchMedia = () => motion;
  const { createParty } = await browser.load("js/party.js");
  const party = createParty({ elements: Object.fromEntries(browser.elements), send() {} });
  const bursts = browser.elements.get("floatingReactions"), feed = browser.elements.get("reactionFeed");
  for (let i = 0; i < 50; i++) party.receiveReaction({ emoji: "❤️", name: "Host" });
  assert.equal(bursts.children.length, 30);
  assert.equal(feed.children.length, 5);
  bursts.children[0].dispatch("animationend");
  assert.equal(bursts.children.length, 29);
  browser.runTimers(2700);
  assert.equal(bursts.children.length, 0);
  party.receiveReaction({ emoji: "❤️", name: "Host" });
  motion.matches = true;
  motionChange();
  assert.equal(bursts.children.length, 0);
  party.receiveReaction({ emoji: "❤️", name: "Host" });
  assert.equal(bursts.children.length, 0);
  assert.equal(feed.children.at(-1).textContent, "❤️ Host");
});

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
  assert.equal(el("floatingReactions").children.length, 6);
  assert.ok(el("floatingReactions").children.every((reaction) => reaction.textContent === "❤️"));
  socket.receive({
    type: "chat", commentId: "12345678-1234-4321-8123-123456789abc",
    clientId: "host-id", name: "Host", message: "A comment", time: "12:00"
  });
  const comment = el("chatMessages").children.at(-1);
  const reactionBar = comment.children[2];
  assert.equal(reactionBar.children.length, 2);
  assert.equal(reactionBar.children.some((button) => button.textContent.includes("0")), false);
  const commentPickerButton = reactionBar.children.find((button) => button.classList.contains("comment-reaction-more"));
  commentPickerButton.dispatch("click");
  const heartEmojiChoice = el("emojiPickerGrid").children.find((button) => button.textContent === "❤️");
  assert.ok(heartEmojiChoice);
  heartEmojiChoice.dispatch("click");
  assert.deepEqual(socket.sent.at(-1), {
    type: "comment-reaction", commentId: "12345678-1234-4321-8123-123456789abc", emoji: "❤️"
  });
  let heartReaction = reactionBar.children.find((button) => button.children[0]?.textContent === "❤️");
  assert.ok(heartReaction);
  assert.equal(heartReaction.children[1].textContent, "1");
  assert.equal(heartReaction.getAttribute("aria-pressed"), "true");
  socket.receive({
    type: "comment-reaction", commentId: "12345678-1234-4321-8123-123456789abc",
    reactions: [{ clientId: "host-id", name: "Host", emoji: "❤️" }]
  });
  assert.equal(heartReaction.getAttribute("aria-pressed"), "true");
  assert.equal(heartReaction.children[1].textContent, "1");
  assert.equal(reactionBar.children.at(-1).classList.contains("pop"), true);
  heartReaction.dispatch("click");
  assert.equal(socket.sent.at(-1).emoji, null);
  assert.equal(reactionBar.children.includes(heartReaction), false);
  assert.equal(reactionBar.children.length, 2);
  socket.receive({
    type: "comment-reaction", commentId: "12345678-1234-4321-8123-123456789abc",
    reactions: []
  });
  assert.equal(heartReaction.getAttribute("aria-pressed"), "false");
  assert.equal(reactionBar.children.includes(heartReaction), false);
  assert.equal(reactionBar.children.length, 2);
  el("chatInput").value = "Hello";
  el("chatInput").selectionStart = 5;
  el("chatInput").selectionEnd = 5;
  el("chatEmojiButton").dispatch("click");
  assert.equal(el("emojiPicker").hidden, false);
  const smiley = el("emojiPickerGrid").children.find((button) => button.textContent === "🥰");
  assert.ok(smiley);
  smiley.dispatch("click");
  assert.equal(el("chatInput").value, "Hello🥰");
  assert.equal(el("emojiPicker").hidden, true);
  commentPickerButton.dispatch("click");
  assert.equal(el("emojiPicker").hidden, false);
  const customEmoji = el("emojiPickerGrid").children.find((button) => button.textContent === "🫶");
  assert.ok(customEmoji);
  customEmoji.dispatch("click");
  assert.deepEqual(socket.sent.at(-1), {
    type: "comment-reaction", commentId: "12345678-1234-4321-8123-123456789abc", emoji: "🫶"
  });
  socket.receive({
    type: "comment-reaction", commentId: "12345678-1234-4321-8123-123456789abc",
    reactions: [{ clientId: "host-id", name: "Host", emoji: "🫶" }]
  });
  const customReaction = comment.children[2].children.find((button) => button.children[0]?.textContent === "🫶");
  assert.ok(customReaction);
  assert.equal(customReaction.children[1].textContent, "1");
  socket.receive({
    type: "comment-reaction", commentId: "12345678-1234-4321-8123-123456789abc",
    reactions: [
      { clientId: "host-id", name: "Host", emoji: "🫶" },
      { clientId: "viewer-id", name: "Viewer", emoji: "🫶" }
    ]
  });
  assert.equal(customReaction.children[1].textContent, "2");
  assert.equal(customReaction.title, "🫶: Host, Viewer");
  assert.match(customReaction.getAttribute("aria-label"), /Host, Viewer/);
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
