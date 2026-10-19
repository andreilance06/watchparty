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
  assert.equal(el("captionControl").hidden, true);
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
