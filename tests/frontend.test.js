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

test("room entry creates a private room with the optional initial name", async () => {
  const browser = createBrowserDouble({ autoContinuePublic: false });
  const payloads = [];
  browser.context.fetch = async (url, options) => {
    payloads.push({ url, options, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({
      room: { watchPath: "/?roomId=created-room", accessCode: "FRIDAY", invitePath: "/?room=FRIDAY" }
    }) };
  };
  await browser.load("js/app.js");
  const el = (id) => browser.elements.get(id);
  assert.equal(el("roomEntry").hidden, false);
  assert.equal(browser.sockets.length, 0, "the public room is not joined before the visitor chooses it");
  el("createRoomChoice").dispatch("click");
  el("initialDisplayName").value = "  Alex  ";
  el("createRoomName").value = "Friday Films";
  el("createRoomCode").value = "friday";
  el("createRoomPassword").value = "secret";
  el("createRoomForm").dispatch("submit");
  await flush();
  assert.equal(payloads[0].url, "/api/rooms");
  assert.deepEqual(payloads[0].body, {
    name: "Friday Films", accessCode: "friday", password: "secret", displayName: "Alex"
  });
  assert.equal(el("createdRoomCode").textContent, "FRIDAY");
  assert.equal(el("roomInviteLink").href, "/?room=FRIDAY");
  assert.equal(el("roomEntrySuccess").hidden, false);
  el("enterCreatedRoom").dispatch("click");
  assert.equal(browser.context.location.href, "/?roomId=created-room");
});

test("room entry joins invitations and omits a blank name for automatic guest naming", async () => {
  const browser = createBrowserDouble({ autoContinuePublic: false });
  browser.context.location.search = "?room=PARTY42";
  const requests = [];
  browser.context.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ room: { watchPath: "/?roomId=joined-room" } }) };
  };
  await browser.load("js/app.js");
  const el = (id) => browser.elements.get(id);
  assert.equal(el("roomEntry").hidden, false);
  assert.equal(el("joinRoomForm").hidden, false);
  assert.equal(el("joinRoomCode").value, "PARTY42");
  el("joinRoomPassword").value = "secret";
  el("joinRoomForm").dispatch("submit");
  await flush();
  assert.equal(requests[0].url, "/api/rooms/join");
  assert.equal(requests[0].body.accessCode, "PARTY42");
  assert.equal(requests[0].body.password, "secret");
  assert.match(requests[0].body.displayName, /^Guest-/);
  assert.equal(browser.context.location.href, "/?roomId=joined-room");
});

test("room entry reports admission errors without navigating", async () => {
  const browser = createBrowserDouble({ autoContinuePublic: false });
  browser.context.fetch = async () => ({
    ok: false, json: async () => ({ error: "Room not found." })
  });
  await browser.load("js/app.js");
  const el = (id) => browser.elements.get(id);
  el("joinRoomChoice").dispatch("click");
  el("joinRoomCode").value = "UNKNOWN";
  el("joinRoomForm").dispatch("submit");
  await flush();
  assert.equal(el("roomEntryStatus").textContent, "Room not found.");
  assert.equal(browser.context.location.href, undefined);
});

test("public room controls reopen room selection without reconnecting twice", async () => {
  const browser = createBrowserDouble({ autoContinuePublic: false });
  await browser.load("js/app.js");
  const el = (id) => browser.elements.get(id);
  el("continuePublicRoom").dispatch("click");
  assert.equal(browser.sockets.length, 1);
  assert.equal(el("roomEntry").hidden, true);
  assert.equal(el("roomInfo").hidden, false);
  assert.equal(el("roomInfoName").textContent, "Default room");
  assert.equal(el("roomInfoCode").textContent, "No access code (public room)");
  assert.equal(el("copyCurrentRoomCode").hidden, true);
  el("roomActionButton").dispatch("click");
  assert.equal(el("roomEntry").hidden, false);
  el("continuePublicRoom").dispatch("click");
  assert.equal(browser.sockets.length, 1);
});

test("private room control leaves through the API and returns to room selection", async () => {
  const browser = createBrowserDouble({ autoContinuePublic: false });
  browser.context.location.search = "?roomId=private-room";
  const requests = [];
  browser.context.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith("/api/session")) {
      return { ok: true, json: async () => ({
        room: { name: "Friday Films", accessCode: "FRIDAY" },
        endpoints: { websocket: "/rooms/private-room/ws" }
      }) };
    }
    return { ok: true, json: async () => ({ left: true }) };
  };
  await browser.load("js/app.js");
  const el = (id) => browser.elements.get(id);
  assert.equal(el("roomEntry").hidden, true);
  assert.equal(el("roomInfo").hidden, false);
  assert.equal(el("roomInfoName").textContent, "Friday Films");
  assert.equal(el("roomInfoCode").textContent, "FRIDAY");
  assert.equal(el("copyCurrentRoomCode").hidden, false);
  const copied = [];
  browser.context.navigator = { clipboard: { writeText: async (code) => copied.push(code) } };
  el("roomInfoToggle").dispatch("click");
  assert.equal(el("roomInfoDetails").hidden, false);
  assert.equal(el("roomInfoToggle").getAttribute("aria-expanded"), "true");
  el("copyCurrentRoomCode").dispatch("click");
  await flush();
  assert.deepEqual(copied, ["FRIDAY"]);
  assert.equal(el("roomInfoStatus").textContent, "Access code copied.");
  browser.document.dispatch("keydown", { key: "Escape" });
  assert.equal(el("roomInfoDetails").hidden, true);
  assert.equal(el("roomInfoToggle").getAttribute("aria-expanded"), "false");
  assert.equal(el("roomActionButton").textContent, "Leave room / switch");
  el("roomActionButton").dispatch("click");
  await flush();
  assert.equal(requests.at(-1).url, "/rooms/private-room/api/leave");
  assert.equal(requests.at(-1).options.method, "POST");
  assert.equal(browser.context.location.href, "/");
});

test("private room control reports leave errors and remains usable", async () => {
  const browser = createBrowserDouble({ autoContinuePublic: false });
  browser.context.location.search = "?roomId=private-room";
  browser.context.fetch = async (url) => url.endsWith("/api/session")
    ? { ok: true, json: async () => ({
      room: { name: "Friday Films", accessCode: "FRIDAY" },
      endpoints: { websocket: "/rooms/private-room/ws" }
    }) }
    : { ok: false, json: async () => ({ error: "Membership expired." }) };
  await browser.load("js/app.js");
  const el = (id) => browser.elements.get(id);
  el("roomActionButton").dispatch("click");
  await flush();
  assert.equal(el("roomActionStatus").textContent, "Membership expired.");
  assert.equal(el("roomActionButton").disabled, false);
  assert.equal(browser.context.location.href, undefined);
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
  await flush();
  el("suggestionResults").children[0].dispatch("click");
  assert.deepEqual(socket.sent.at(-1), { type: "suggest-video", title: "The Next Movie" });
  socket.receive({
    type: "party-state",
    myVoteId: 2,
    participants: [
      { clientId: "host-id", name: "Host", role: "host" },
      { clientId: "viewer-id", name: "Viewer", role: "viewer" }
    ],
    suggestions: [{ id: 2, title: "The Next Movie", ownerId: "viewer-id", ownerName: "Viewer", votes: 1 }]
  });
  assert.equal(el("participantList").children.length, 2);
  assert.equal(el("voteLeader").textContent, "Leading: The Next Movie (1 vote)");
  const voteButton = el("voteOptions").children[0].children[2];
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

test("voting uses party-state for counts, ties, selections, posters, and replaceable votes", async () => {
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

  const suggestions = [{ id: 1, title: "Arrival", ownerId: "host-id", ownerName: "Host", votes: 0 }, { id: 2, title: "Moonlight", votes: 0 }];
  socket.receive({ type: "party-state", suggestions, myVoteId: null });
  assert.equal(el("voteLeader").textContent, "No votes yet.");
  el("voteOptions").children[0].children[2].dispatch("click");
  assert.deepEqual(socket.sent.at(-1), { type: "vote-video", suggestionId: 1 });

  suggestions[0].votes = 2;
  suggestions[1].votes = 1;
  socket.receive({ type: "party-state", suggestions, myVoteId: 1 });
  assert.equal(el("voteStatus").textContent, "3 votes cast");
  assert.equal(el("voteLeader").textContent, "Leading: Arrival (2 votes)");
  let rows = el("voteOptions").children;
  assert.equal(rows[0].children[1].children[1].textContent, "2 votes · 67%");
  assert.equal(rows[0].children[1].children[2].children[0].style.width, "67%");
  assert.equal(rows[0].children[2].disabled, true);
  assert.equal(rows[1].children[2].disabled, false);
  rows[1].children[2].dispatch("click");
  assert.deepEqual(socket.sent.at(-1), { type: "vote-video", suggestionId: 2 });

  suggestions[0].votes = 1;
  suggestions[1].votes = 2;
  socket.receive({ type: "party-state", suggestions, myVoteId: 2 });
  rows = el("voteOptions").children;
  assert.equal(rows[0].children[2].getAttribute("aria-pressed"), "false");
  assert.equal(rows[0].children[2].disabled, false);
  assert.equal(rows[1].children[2].getAttribute("aria-pressed"), "true");
  assert.equal(rows[1].children[2].disabled, true);

  suggestions[1].votes = 1;
  socket.receive({ type: "party-state", suggestions, myVoteId: null });
  assert.equal(el("voteLeader").textContent, "Tie: Arrival, Moonlight (1 vote each)");
  assert.equal(el("voteOptions").children[0].children[1].children[2].children[0].style.width, "50%");
  const title = '<img src=x onerror="alert(1)">';
  socket.receive({ type: "party-state", suggestions: [{ id: 3, title, votes: 0 }] });
  assert.equal(el("voteOptions").children[0].children[1].children[0].textContent, title);
  assert.equal(el("voteOptions").children[0].children[1].children[0].children.length, 0);

  socket.receive({ type: "party-state", suggestions: [{
    id: 4, title: "Arrival", votes: 1,
    movie: { pageUrl: "https://en.wikipedia.org/wiki/Arrival_(film)", posterUrl: "https://upload.wikimedia.org/wikipedia/en/poster.jpg", description: "A science fiction film." }
  }] });
  const posterRow = el("voteOptions").children[0];
  assert.equal(posterRow.children[0].children[0].src, "https://upload.wikimedia.org/wikipedia/en/poster.jpg");
  assert.equal(posterRow.children[1].children[3].textContent, "A science fiction film.");
  assert.equal(posterRow.children[1].children[4].textContent, "Wikipedia");
});

test("only the suggestion owner sees its remove control", async () => {
  const browser = createBrowserDouble();
  await browser.load("js/app.js");
  const socket = browser.sockets[0];
  const el = (id) => browser.elements.get(id);
  socket.open();
  socket.receive({ type: "role", role: "host", clientId: "host-id", name: "Host" });
  socket.receive({ type: "party-state", suggestions: [
    { id: 1, title: "Host's Movie", ownerId: "host-id", ownerName: "Host", votes: 0 },
    { id: 2, title: "Viewer's Movie", ownerId: "viewer-id", ownerName: "Viewer", votes: 0 }
  ] });
  let rows = el("voteOptions").children;
  assert.equal(rows[0].children.at(-1).className, "vote-remove-button");
  assert.equal(rows[1].children.some((child) => child.className === "vote-remove-button"), false);
  rows[0].children.at(-1).dispatch("click");
  assert.deepEqual(socket.sent.at(-1), { type: "remove-video-suggestion", suggestionId: 1 });

  socket.receive({ type: "role", role: "viewer", clientId: "viewer-id", name: "Viewer" });
  socket.receive({ type: "party-state", suggestions: [
    { id: 1, title: "Host's Movie", ownerId: "host-id", ownerName: "Host", votes: 0 },
    { id: 2, title: "Viewer's Movie", ownerId: "viewer-id", ownerName: "Viewer", votes: 0 }
  ] });
  rows = el("voteOptions").children;
  assert.equal(rows[0].children.some((child) => child.className === "vote-remove-button"), false);
  assert.equal(rows[1].children.at(-1).className, "vote-remove-button");
});

test("movie search selects a matching Wikimedia result and keeps a title-only fallback", async () => {
  const browser = createBrowserDouble();
  const movie = {
    pageId: 23270459,
    title: "Inception",
    description: "A science fiction film.",
    pageUrl: "https://en.wikipedia.org/wiki/Inception",
    posterUrl: "https://upload.wikimedia.org/wikipedia/en/poster.jpg"
  };
  browser.context.fetch = async (url) => {
    browser.requests.push({ url });
    return { ok: true, json: async () => ({ movies: [movie] }) };
  };
  await browser.load("js/app.js");
  const socket = browser.sockets[0];
  socket.open();
  const el = (id) => browser.elements.get(id);
  el("suggestionInput").value = "Inception";
  el("suggestionForm").dispatch("submit");
  await flush();
  assert.match(browser.requests[0].url, /\/api\/movies\/search\?q=Inception/);
  assert.equal(el("suggestionResults").children.length, 2);
  const result = el("suggestionResults").children[0];
  assert.equal(result.children[0].src, movie.posterUrl);
  result.children[1].children[3].dispatch("click");
  assert.deepEqual(socket.sent.at(-1), { type: "suggest-video", title: "Inception", movie });
  assert.equal(el("suggestionStatus").textContent, "Suggested “Inception”. Your vote is recorded automatically.");

  browser.context.fetch = async () => { throw new Error("offline"); };
  el("suggestionInput").value = "Unknown Film";
  el("suggestionForm").dispatch("submit");
  await flush();
  assert.match(el("suggestionStatus").textContent, /You can still suggest the title without a poster/);
  el("suggestionResults").children[0].dispatch("click");
  assert.deepEqual(socket.sent.at(-1), { type: "suggest-video", title: "Unknown Film" });
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
