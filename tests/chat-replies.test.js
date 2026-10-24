const { replyTo, openGlobalPicker } = require("./helpers/chat-actions");
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomFillSync } = require("node:crypto");
const { createSession } = require("../server/state");
const { createMessageHandler } = require("../server/messages");
const { createBrowserDouble } = require("./helpers/browser");

test("replies use canonical snapshots, correlate errors, and expire with reaction targets", () => {
  const state = createSession(), sent = [], broadcasts = [];
  const ws = { clientId: "host" };
  state.clients.set(ws.clientId, { ws, role: "host", name: "Original name" });
  const handler = createMessageHandler({ state, media: {}, transport: {
    send: (_, message) => sent.push(message), broadcast: message => broadcasts.push(message)
  } });
  handler.handleMessage(ws, { type: "chat", message: "<script>original</script>" });
  const original = broadcasts.at(-1);
  state.clients.get(ws.clientId).name = "New name";
  handler.handleMessage(ws, { type: "chat", message: "Reply", replyToId: original.commentId,
    requestId: "reply-1", replyTo: { name: "Forged", message: "Forged" } });
  assert.deepEqual(broadcasts.at(-1).replyTo, {
    commentId: original.commentId, name: "Original name", message: original.message
  });
  assert.equal(broadcasts.at(-1).requestId, "reply-1");
  const replyId = broadcasts.at(-1).commentId;
  handler.handleMessage(ws, { type: "chat", message: "Nested", replyToId: replyId });
  assert.equal(broadcasts.at(-1).replyTo.message, "Reply", "Snapshots contain only the immediate parent");
  for (const replyToId of ["unknown", {}, [], 42, "00000000-0000-4000-8000-000000000000"]) {
    const count = broadcasts.length;
    handler.handleMessage(ws, { type: "chat", message: "Rejected", replyToId, requestId: "bad" });
    assert.equal(broadcasts.length, count);
    assert.equal(sent.at(-1).code, "REPLY_UNAVAILABLE");
    assert.equal(sent.at(-1).requestId, "bad");
  }
  for (let i = 0; i < 500; i++) handler.handleMessage(ws, { type: "chat", message: String(i) });
  assert.equal(state.comments.size, 500);
  assert.deepEqual([...state.comments.keys()], [...state.commentReactions.keys()]);
  handler.handleMessage(ws, { type: "chat", message: "Expired", replyToId: original.commentId });
  assert.equal(sent.at(-1).code, "REPLY_UNAVAILABLE");
});

async function chatBrowser(overrides = {}) {
  const browser = createBrowserDouble();
  Object.assign(browser.context, overrides);
  await browser.load("js/app.js");
  const socket = browser.sockets[0], el = id => browser.elements.get(id);
  socket.open();
  socket.receive({ type: "role", clientId: "self", name: "Me", role: "host" });
  const add = (id, extra = {}) => {
    socket.receive({ type: "chat", commentId: id, clientId: "other", name: "Friend", message: `Message ${id}`, ...extra });
    return el("chatMessages").children.at(-1);
  };
  return { ...browser, socket, el, add };
}

for (const [environment, crypto] of [
  ["getRandomValues only", { getRandomValues: bytes => randomFillSync(bytes) }],
  ["no crypto API", undefined]
]) {
  test(`chat sends and replies without randomUUID (${environment})`, async () => {
    const { socket, el, add } = await chatBrowser({ crypto });
    const original = add("original");
    const requestIds = new Set();
    for (const replying of [false, true, false]) {
      if (replying) replyTo(el, original);
      el("chatInput").value = replying ? "  A reply  " : "  A message  ";
      el("chatForm").dispatch("submit");
      const request = socket.sent.at(-1);
      assert.equal(request.type, "chat");
      assert.equal(request.message, replying ? "A reply" : "A message");
      assert.equal(request.replyToId, replying ? "original" : undefined);
      assert.equal(typeof request.requestId, "string");
      assert.ok(request.requestId.length > 0 && request.requestId.length <= 100);
      assert.equal(requestIds.has(request.requestId), false);
      requestIds.add(request.requestId);
      assert.equal(el("chatInput").value, replying ? "  A reply  " : "  A message  ");
      assert.equal(el("chatForm").getAttribute("aria-busy"), "true");
      socket.receive({ ...request, commentId: `accepted-${requestIds.size}`, clientId: "self", name: "Me" });
      assert.equal(el("chatInput").value, "");
      assert.equal(el("chatForm").getAttribute("aria-busy"), null);
      assert.equal(el("chatReplyPreview").hidden, true);
      assert.equal(el("chatMessages").children.at(-1).querySelector("p").textContent, request.message);
    }
  });

  test(`chat renders messages without comment IDs (${environment})`, async () => {
    const { socket, el } = await chatBrowser({ crypto });
    for (const message of ["First message", "Second message"]) {
      socket.receive({ type: "chat", clientId: "other", name: "Friend", message });
    }
    const articles = el("chatMessages").querySelectorAll(".chat-message");
    assert.equal(articles.length, 2);
    assert.ok(articles[0].dataset.commentId);
    assert.ok(articles[1].dataset.commentId);
    assert.notEqual(articles[0].dataset.commentId, articles[1].dataset.commentId);
    assert.equal(articles[1].querySelector("p").textContent, "Second message");
  });
}

test("inline replies preserve drafts, replace targets, cancel, and clear only on accepted echo", async () => {
  const { socket, el, add } = await chatBrowser();
  const first = add("first", { name: "<Friend>", message: "<b>plain text</b>" });
  el("chatInput").value = "  My reply  ";
  replyTo(el, first);
  assert.equal(el("chatReplyName").textContent, "Reply to <Friend>");
  assert.equal(el("chatReplyText").textContent, "<b>plain text</b>");
  assert.equal(el("chatReplyPreview").hidden, false);
  replyTo(el, add("second"));
  assert.equal(el("chatInput").value, "  My reply  ");
  el("chatReplyCancel").click();
  assert.equal(el("chatReplyPreview").hidden, true);
  replyTo(el, first);
  el("chatForm").dispatch("submit");
  const request = socket.sent.at(-1);
  assert.equal(request.replyToId, "first");
  assert.equal(request.message, "My reply");
  assert.equal(el("chatInput").value, "  My reply  ");
  const count = socket.sent.length;
  el("chatForm").dispatch("submit");
  assert.equal(socket.sent.length, count, "Pending sends cannot be duplicated");
  socket.receive({ type: "chat", commentId: "echo", clientId: "self", name: "Me", message: request.message,
    requestId: request.requestId, replyTo: { commentId: "first", name: "<Friend>", message: "<b>plain text</b>" } });
  assert.equal(el("chatInput").value, "");
  assert.equal(el("chatReplyPreview").hidden, true);
  const quote = el("chatMessages").children.at(-1).querySelector(".chat-reply-quote");
  assert.equal(quote.children[1].textContent, "<b>plain text</b>");
  quote.click();
  assert.equal(first.scrolledIntoView.block, "center");
  assert.equal(first.classList.contains("reply-highlight"), true);
});

test("failed replies and disconnections retain drafts and a later edit survives an earlier echo", async () => {
  const { socket, el, add } = await chatBrowser();
  replyTo(el, add("first"));
  el("chatInput").value = "Keep this";
  el("chatForm").dispatch("submit");
  socket.receive({ type: "error", action: "chat", requestId: socket.sent.at(-1).requestId,
    code: "REPLY_UNAVAILABLE", message: "Cancel your reply" });
  assert.equal(el("chatInput").value, "Keep this");
  assert.equal(el("chatReplyPreview").hidden, false);
  assert.equal(el("chatSendStatus").textContent, "Cancel your reply");
  el("chatReplyCancel").click();
  el("chatForm").dispatch("submit");
  const request = socket.sent.at(-1);
  el("chatInput").value = "A new draft";
  socket.receive({ type: "chat", commentId: "accepted", clientId: "self", requestId: request.requestId, message: "Keep this" });
  assert.equal(el("chatInput").value, "A new draft");
  socket.close();
  el("chatForm").dispatch("submit");
  assert.equal(el("chatInput").value, "A new draft");
  assert.match(el("chatSendStatus").textContent, /Reconnect/);
});

test("quotes survive local eviction and incoming messages do not interrupt older reading", async () => {
  const { el, add } = await chatBrowser();
  add("old");
  for (let i = 0; i < 20; i++) add(String(i));
  el("chatMessages").scrollTop = 0;
  el("chatMessages").dispatch("scroll");
  add("new");
  assert.equal(el("chatMessages").scrollTop, 0);
  assert.equal(el("chatJumpLatest").hidden, false);
  el("chatJumpLatest").click();
  assert.equal(el("chatJumpLatest").hidden, true);
  for (let i = 0; i < 500; i++) add(`evict-${i}`);
  const reply = add("reply", { replyTo: { commentId: "old", name: "Friend", message: "Still quoted" } });
  reply.querySelector(".chat-reply-quote").click();
  assert.equal(el("chatSendStatus").textContent, "Original message unavailable");
  assert.equal(reply.querySelector(".chat-reply-quote").children[1].textContent, "Still quoted");
});

test("fullscreen preserves the same conversation, scroll and draft, and mounts reaction/picker portals", async () => {
  const { document, el, add } = await chatBrowser();
  const parents = new Map(["chatConversation", "floatingReactions", "reactionFeed", "emojiPicker", "messageMenu"].map(id => [id, el(id).parentNode]));
  replyTo(el, add("first"));
  el("chatInput").value = "Fullscreen draft";
  el("chatMessages").scrollTop = 17;
  openGlobalPicker(el);
  await el("videoShell").requestFullscreen();
  assert.equal(el("emojiPicker").hidden, true);
  assert.equal(el("chatConversation").parentNode, el("fullscreenChat"));
  for (const id of ["floatingReactions", "reactionFeed", "emojiPicker", "messageMenu"]) assert.equal(el(id).parentNode, el("videoShell"));
  assert.equal(el("chatMessages").scrollTop, 17);
  assert.equal(el("chatInput").value, "Fullscreen draft");
  assert.equal(el("chatReplyPreview").hidden, false);
  openGlobalPicker(el);
  assert.equal(el("emojiPicker").hidden, false);
  el("fullscreenChatToggle").click();
  assert.equal(el("fullscreenChat").hidden, true);
  assert.equal(el("emojiPicker").hidden, true);
  assert.equal(el("fullscreenChatLabel").textContent, "Show chat");
  await document.exitFullscreen();
  for (const [id, parent] of parents) assert.equal(el(id).parentNode, parent);
  assert.equal(el("chatMessages").scrollTop, 17);
  assert.equal(el("chatInput").value, "Fullscreen draft");
  assert.equal(el("fullscreenChatToggle").hidden, true);
});

test("pseudo and WebKit fullscreen restore the conversation, and Escape first closes its picker", async () => {
  const { document, el } = await chatBrowser();
  const shell = el("videoShell"), parent = el("chatConversation").parentNode;
  shell.requestFullscreen = undefined;
  el("video").dispatch("movi-fullscreen-request");
  assert.equal(shell.classList.contains("pseudo-fullscreen"), true);
  el("chatEmojiButton").click();
  document.dispatch("keydown", { key: "Escape" });
  assert.equal(shell.classList.contains("pseudo-fullscreen"), true);
  assert.equal(el("emojiPicker").hidden, true);
  document.dispatch("keydown", { key: "Escape" });
  assert.equal(shell.classList.contains("pseudo-fullscreen"), false);
  assert.equal(el("chatConversation").parentNode, parent);
  shell.webkitRequestFullscreen = () => { document.webkitFullscreenElement = shell; document.dispatch("webkitfullscreenchange"); };
  el("video").dispatch("movi-fullscreen-request");
  assert.equal(el("chatConversation").parentNode, el("fullscreenChat"));
  document.webkitFullscreenElement = null;
  document.dispatch("webkitfullscreenchange");
  assert.equal(el("chatConversation").parentNode, parent);
});

test("the global picker exposes hundreds of reactions without inserting into the draft", async () => {
  const { el, socket, runTimers } = await chatBrowser();
  el("chatInput").value = "Unchanged";
  openGlobalPicker(el);
  assert.ok(el("emojiPickerGrid").children.length > 250);
  assert.equal(el("emojiPicker").getAttribute("aria-label"), "Send global reaction");
  const choice = el("emojiPickerGrid").children[42];
  choice.click();
  assert.deepEqual(socket.sent.at(-1), { type: "reaction", emoji: choice.textContent });
  assert.equal(el("chatInput").value, "Unchanged");
  socket.receive({ type: "reaction", emoji: choice.textContent, name: "Friend" });
  assert.equal(el("reactionFeed").children.length, 1);
  runTimers(4000);
  assert.equal(el("reactionFeed").children.length, 0);
});
