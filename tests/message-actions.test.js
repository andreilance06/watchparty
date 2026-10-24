const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrowserDouble } = require("./helpers/browser");
const { openMessageActions, expandReactions, openGlobalPicker } = require("./helpers/chat-actions");
const { createApplication } = require("../server/application");
const { CPU_ENCODER } = require("../server/encoders");
const { connectPeer } = require("./helpers/peer");

async function setup() {
  const browser = createBrowserDouble();
  await browser.load("js/app.js");
  const el = id => browser.elements.get(id), socket = browser.sockets[0];
  socket.open(); socket.receive({ type: "role", role: "host", clientId: "me", name: "Me" });
  const add = id => {
    socket.receive({ type: "chat", commentId: id, clientId: "friend", name: "Friend", message: "Message" });
    return el("chatMessages").children.at(-1);
  };
  return { ...browser, el, socket, add };
}

test("message actions replace standalone buttons and support keyboard focus, selection and dismissal", async () => {
  const { el, add, document, socket, window } = await setup();
  const article = add("first");
  assert.equal(article.querySelector(".comment-reply-button"), null);
  assert.equal(article.querySelector(".comment-reaction-more"), null);
  const event = article.dispatch("contextmenu", { clientX: 990, clientY: 790 });
  assert.equal(event.defaultPrevented, true);
  assert.equal(el("messageMenu").hidden, false);
  assert.equal(article.getAttribute("aria-expanded"), "true");
  assert.ok(parseFloat(el("messageMenu").style.left) <= 1000 - el("messageMenu").clientWidth - 8);
  document.dispatch("keydown", { key: "End" });
  assert.equal(el("messageMenu").children.at(-1).focused, true);
  document.dispatch("keydown", { key: "Escape" });
  assert.equal(el("messageMenu").hidden, true);
  assert.equal(article.focused, true);
  assert.equal(article.getAttribute("aria-expanded"), "false");
  article.dispatch("keydown", { key: "F10", shiftKey: true });
  assert.equal(el("messageMenu").hidden, false);
  el("messageMenu").querySelectorAll(".message-menu-reaction")[0].click();
  assert.equal(el("messageMenu").hidden, true);
  assert.equal(socket.sent.at(-1).type, "comment-reaction");
  assert.equal(article.querySelectorAll(".comment-reaction").length, 0, "No optimistic extra reaction");
  article.dispatch("keydown", { key: "ContextMenu" });
  document.dispatch("pointerdown", { composedPath: () => [el("chatInput")] });
  assert.equal(el("messageMenu").hidden, true);
  openMessageActions(el, article);
  window.dispatch("scroll");
  assert.equal(el("messageMenu").hidden, true);
  openMessageActions(el, article);
  window.dispatch("resize");
  assert.equal(el("messageMenu").hidden, true);
});

test("touch hold opens actions while movement, release and cancellation preserve scrolling", async () => {
  const { el, add, runTimers, window } = await setup();
  const article = add("first");
  const down = () => article.dispatch("pointerdown", { pointerType: "touch", clientX: 30, clientY: 30 });
  for (const cancel of [
    () => article.dispatch("pointermove", { clientX: 41, clientY: 30 }),
    () => article.dispatch("pointerup"),
    () => article.dispatch("pointercancel"),
    () => window.dispatch("scroll")
  ]) {
    down(); cancel(); runTimers(500);
    assert.notEqual(el("messageMenu").hidden, false);
  }
  down(); runTimers(500);
  assert.equal(el("messageMenu").hidden, false);
  assert.equal(article.dispatch("click").defaultPrevented, true, "The hold must not activate a quote or pill");
});

test("counts and ownership follow personalized snapshots even when another tab cast the reaction", async () => {
  const { el, socket, add } = await setup();
  const article = add("first"), heart = "\u2764\ufe0f", laugh = "\ud83d\ude02";
  const snapshot = (myReaction, reactions) => socket.receive({ type: "comment-reaction", commentId: "first", myReaction, reactions });
  snapshot(null, [{ clientId: "friend", name: "Friend", emoji: heart }]);
  const pill = () => article.querySelector(".comment-reaction");
  assert.equal(pill().getAttribute("aria-pressed"), "false");
  pill().click(); assert.equal(socket.sent.at(-1).emoji, heart);
  snapshot(heart, [{ clientId: "other-tab", name: "Me elsewhere", emoji: heart }, { clientId: "friend", name: "Friend", emoji: heart }]);
  assert.equal(pill().getAttribute("aria-pressed"), "true");
  assert.equal(pill().children[1].textContent, "2");
  pill().click(); assert.equal(socket.sent.at(-1).emoji, null);
  const menu = openMessageActions(el, article);
  assert.equal(menu.querySelector(".message-menu-reaction").classList.contains("selected"), true);
  snapshot(laugh, [{ clientId: "other-tab", name: "Me elsewhere", emoji: laugh }, { clientId: "friend", name: "Friend", emoji: heart }]);
  assert.equal(menu.querySelector(".message-menu-reaction").classList.contains("selected"), false);
  const pills = article.querySelectorAll(".comment-reaction");
  assert.equal(pills.filter(button => button.getAttribute("aria-pressed") === "true").length, 1);
  pills.find(button => button.children[0].textContent === heart).click();
  assert.equal(socket.sent.at(-1).emoji, heart, "Choosing another pill replaces the previous reaction");
});

test("one composer picker has explicit tabs, keyboard switching, and a fresh insertion default", async () => {
  const { el, socket } = await setup();
  assert.equal(el("globalReactionButton"), undefined);
  el("chatInput").value = "Hello world";
  el("chatInput").setSelectionRange(6, 11);
  el("chatEmojiButton").click();
  assert.equal(el("emojiPickerTabs").hidden, false);
  assert.equal(el("emojiMessageTab").getAttribute("aria-selected"), "true");
  el("emojiSearch").value = "heart"; el("emojiSearch").dispatch("input");
  el("emojiPickerTabs").dispatch("keydown", { key: "ArrowRight" });
  assert.equal(el("emojiGlobalTab").getAttribute("aria-selected"), "true");
  assert.equal(el("emojiGlobalTab").focused, true);
  assert.equal(el("emojiSearch").value, "heart");
  const choice = el("emojiPickerGrid").children[0]; choice.click();
  assert.deepEqual(socket.sent.at(-1), { type: "reaction", emoji: choice.textContent });
  assert.equal(el("chatInput").value, "Hello world");
  assert.equal(el("emojiPicker").hidden, false);
  el("chatEmojiButton").click();
  assert.equal(el("emojiPicker").hidden, true);
  el("chatEmojiButton").click();
  assert.equal(el("emojiMessageTab").getAttribute("aria-selected"), "true");
  const insert = el("emojiPickerGrid").children[0]; insert.click();
  assert.equal(el("chatInput").value, `Hello ${insert.textContent}`);
});

test("message menus and the unified picker are exclusive, fullscreen-contained, and evict safely", async () => {
  const { el, add, document } = await setup();
  const first = add("first"), parent = el("messageMenu").parentNode;
  openGlobalPicker(el);
  openMessageActions(el, first);
  assert.equal(el("emojiPicker").hidden, true);
  const expanded = expandReactions(el, first);
  assert.equal(el("messageMenu").hidden, false);
  assert.equal(expanded.hidden, false);
  assert.equal(el("emojiPicker").hidden, true);
  await el("videoShell").requestFullscreen();
  assert.equal(el("messageMenu").parentNode, el("videoShell"));
  openMessageActions(el, first);
  el("fullscreenChatToggle").click();
  assert.equal(el("messageMenu").hidden, true);
  el("fullscreenChatToggle").click();
  openMessageActions(el, first);
  for (let i = 0; i < 500; i++) add(String(i));
  assert.equal(el("messageMenu").hidden, true);
  await document.exitFullscreen();
  assert.equal(el("messageMenu").parentNode, parent);
});

test("persistent insertion preserves search, scroll and cursor across repeated selections and mode switches", async () => {
  const { el, socket, document } = await setup();
  el("chatInput").value = "Hello world!";
  el("chatInput").setSelectionRange(6, 11);
  el("chatEmojiButton").click();
  el("emojiSearch").value = "heart";
  el("emojiSearch").dispatch("input");
  const choices = el("emojiPickerGrid").children;
  el("emojiPickerGrid").scrollTop = 42;
  choices[0].click(); choices[1].click();
  const firstPair = choices[0].textContent + choices[1].textContent;
  assert.equal(el("chatInput").value, `Hello ${firstPair}!`);
  assert.equal(el("chatInput").selectionStart, 6 + firstPair.length);
  assert.equal(el("emojiSearch").value, "heart");
  assert.equal(el("emojiPickerGrid").scrollTop, 42);
  assert.equal(el("emojiPickerGrid").children[0], choices[0]);
  assert.equal(document.body.activeElement, choices[1]);
  el("emojiGlobalTab").click(); choices[2].click();
  assert.equal(socket.sent.at(-1).type, "reaction");
  assert.equal(el("chatInput").value, `Hello ${firstPair}!`);
  assert.equal(el("emojiGlobalTab").getAttribute("aria-selected"), "true");
  el("emojiMessageTab").click(); choices[3].click();
  assert.equal(el("chatInput").value, `Hello ${firstPair}${choices[3].textContent}!`);
  assert.equal(el("emojiPicker").hidden, false);
});

test("repeated emoji insertion respects the length limit without advancing a rejected insertion", async () => {
  const { el, document } = await setup();
  el("chatInput").value = "ab";
  el("chatInput").maxLength = 6;
  el("chatInput").setSelectionRange(2, 2);
  el("chatEmojiButton").click();
  const choice = el("emojiPickerGrid").children[0];
  assert.equal(choice.textContent.length, 2, "The first emoji uses a surrogate pair");
  choice.click(); choice.click(); choice.click();
  assert.equal(el("chatInput").value, `ab${choice.textContent}${choice.textContent}`);
  assert.equal(el("chatInput").selectionStart, 6);
  assert.equal(el("emojiPicker").hidden, false);
  assert.equal(document.body.activeElement, choice);
});

test("global picker and expanded message reactions stay open after repeated selections", async () => {
  const { el, socket, add, document } = await setup();
  openGlobalPicker(el);
  const global = el("emojiPickerGrid").children[0], sentBefore = socket.sent.length;
  global.click(); global.click();
  assert.equal(socket.sent.length, sentBefore + 2);
  assert.equal(el("emojiPicker").hidden, false);
  assert.equal(el("emojiGlobalTab").getAttribute("aria-selected"), "true");
  const article = add("first");
  const menu = openMessageActions(el, article);
  const more = menu.querySelector('[aria-label="More reactions"]');
  assert.equal(more.parentNode, menu.querySelector(".message-menu-reactions"));
  const expanded = menu.querySelector(".message-menu-expanded");
  assert.equal(more.getAttribute("aria-controls"), expanded.id);
  assert.equal(more.getAttribute("aria-haspopup"), null);
  document.dispatch("keydown", { key: "Home" });
  for (let i = 0; i < 8; i++) document.dispatch("keydown", { key: "ArrowRight" });
  assert.equal(document.body.activeElement, more);
  more.click();
  assert.equal(expanded.hidden, false);
  assert.equal(el("emojiPicker").hidden, true);
  const first = expanded.children[0], second = expanded.children[1];
  expanded.scrollTop = 42;
  first.click();
  socket.receive({ type: "comment-reaction", commentId: "first", myReaction: first.textContent,
    reactions: [{ clientId: "me", name: "Me", emoji: first.textContent }] });
  second.click();
  assert.equal(socket.sent.at(-1).emoji, second.textContent);
  socket.receive({ type: "comment-reaction", commentId: "first", myReaction: second.textContent,
    reactions: [{ clientId: "me", name: "Me", emoji: second.textContent }] });
  second.click();
  assert.equal(socket.sent.at(-1).emoji, null);
  assert.equal(menu.hidden, false);
  assert.equal(expanded.hidden, false);
  assert.equal(expanded.scrollTop, 42);
  assert.equal(document.body.activeElement, second);
  document.dispatch("keydown", { key: "Escape" });
  assert.equal(expanded.hidden, true);
  assert.equal(menu.hidden, false);
  assert.equal(document.body.activeElement, more);
  document.dispatch("keydown", { key: "Escape" });
  assert.equal(menu.hidden, true);
  assert.equal(document.body.activeElement, article);
});

test("real sockets share one reaction across browser tabs and reconnect with personalized ownership", async t => {
  const app = createApplication({ config: { port: 0, hostReconnectGraceMs: 0 }, encoderPromise: Promise.resolve(CPU_ENCODER) });
  const address = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  const identity = await fetch(`${base}/api/viewer-identity`, { method: "POST" });
  const cookie = identity.headers.get("set-cookie").split(";")[0];
  const connect = async name => {
    const peer = await connectPeer(base.replace("http", "ws"), name, { headers: { Cookie: cookie } });
    t.after(() => peer.ws.terminate()); return peer;
  };
  const first = await connect("First"), second = await connect("Second");
  const outsider = await connectPeer(base.replace("http", "ws"), "Other");
  t.after(() => outsider.ws.terminate());
  first.send({ type: "chat", message: "Target" });
  const comment = await second.next("chat");
  const react = (peer, emoji) => peer.send({ type: "comment-reaction", commentId: comment.commentId, emoji });
  const heart = "\u2764\ufe0f", laugh = "\ud83d\ude02";
  react(first, heart);
  assert.equal((await second.next("comment-reaction")).myReaction, heart);
  assert.equal((await outsider.next("comment-reaction")).myReaction, null);
  react(second, laugh);
  const changed = await first.next("comment-reaction", message => message.myReaction === laugh);
  assert.equal(changed.reactions.length, 1);
  assert.equal(changed.reactions[0].clientId, second.role.clientId);
  first.ws.close();
  const reconnected = await connect("Returned");
  const restored = await reconnected.next("comment-reaction");
  assert.equal(restored.myReaction, laugh);
  assert.equal(restored.reactions.length, 1);
  react(reconnected, null);
  const removed = await second.next("comment-reaction", message => message.myReaction === null);
  assert.deepEqual(removed.reactions, []);
});

test("the chevron expands in place, updates ownership, and collapses before the menu closes", async () => {
  const { el, add, socket, document, window } = await setup();
  const article = add("target"), menu = openMessageActions(el, article);
  const more = menu.querySelector('[aria-label="More reactions"]');
  const extra = menu.querySelector(".message-menu-expanded");
  assert.equal(extra.hidden, true);
  assert.equal(more.getAttribute("aria-expanded"), "false");
  more.click();
  assert.equal(menu.hidden, false);
  assert.equal(extra.hidden, false);
  assert.equal(more.getAttribute("aria-expanded"), "true");
  assert.equal(el("emojiPicker").hidden, true);
  assert.ok(extra.children.length > 250);
  const first = extra.children[0], second = extra.children[1];
  extra.scrollTop = 96;
  first.click();
  socket.receive({ type: "comment-reaction", commentId: "target", myReaction: first.textContent,
    reactions: [{ clientId: "another-tab", name: "Me", emoji: first.textContent }] });
  assert.equal(first.classList.contains("selected"), true);
  socket.receive({ type: "comment-reaction", commentId: "target", myReaction: second.textContent,
    reactions: [{ clientId: "another-tab", name: "Me", emoji: second.textContent }] });
  assert.equal(first.classList.contains("selected"), false);
  assert.equal(second.classList.contains("selected"), true);
  assert.equal(extra.scrollTop, 96);
  assert.equal(extra.children[0], first, "Snapshots must not rebuild the expanded grid");
  more.click();
  assert.equal(extra.hidden, true);
  assert.equal(menu.hidden, false);
  more.click();
  assert.equal(extra.scrollTop, 96);
  document.dispatch("keydown", { key: "ArrowDown" });
  assert.equal(document.body.activeElement, first);
  document.dispatch("keydown", { key: "ArrowDown" });
  assert.equal(document.body.activeElement, extra.children[8]);
  document.dispatch("keydown", { key: "ArrowUp" });
  document.dispatch("keydown", { key: "ArrowUp" });
  assert.equal(document.body.activeElement, more);
  window.dispatch("scroll", { target: extra });
  assert.equal(menu.hidden, false, "Internal reaction scrolling leaves the menu open");
  document.dispatch("keydown", { key: "Escape" });
  assert.equal(extra.hidden, true);
  assert.equal(menu.hidden, false);
  assert.equal(document.body.activeElement, more);
  document.dispatch("keydown", { key: "Escape" });
  assert.equal(menu.hidden, true);
  openMessageActions(el, article);
  assert.equal(extra.hidden, true);
  assert.equal(extra.scrollTop, 0);
  more.click();
  document.dispatch("pointerdown", { composedPath: () => [el("chatInput")] });
  assert.equal(menu.hidden, true);
  assert.equal(extra.hidden, true);
});

test("expansion repositions the same menu to fit near the bottom of the viewport", async () => {
  const { el, add } = await setup();
  const article = add("target"), menu = el("messageMenu");
  const extra = menu.querySelector(".message-menu-expanded");
  menu.getBoundingClientRect = () => ({ width: 352, height: extra.hidden ? 100 : 400 });
  article.dispatch("contextmenu", { clientX: 990, clientY: 790 });
  assert.equal(menu.style.left, "640px");
  assert.equal(menu.style.top, "692px");
  menu.querySelector('[aria-label="More reactions"]').click();
  assert.equal(menu.style.top, "392px");
  assert.equal(menu.hidden, false);
  menu.querySelector('[aria-label="More reactions"]').click();
  assert.equal(menu.style.top, "692px");
});
