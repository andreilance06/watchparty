const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrowserDouble } = require("./helpers/browser");

async function setup() {
  const b = createBrowserDouble();
  await b.load("js/app.js");
  b.el = id => b.elements.get(id);
  b.socket = b.sockets[0];
  b.socket.open();
  b.socket.receive({ type: "role", clientId: "self", name: "Me", role: "host" });
  return b;
}

test("social tabs support keyboard selection, keep drafts and reveal unread conversation", async () => {
  const b = await setup();
  b.el("chatInput").value = "An unfinished thought";
  b.el("socialTabs").dispatch("keydown", { key: "ArrowRight" });
  assert.equal(b.el("peopleTab").getAttribute("aria-selected"), "true");
  assert.equal(b.el("peopleTab").focused, true);
  assert.equal(b.el("socialChat").hidden, true);
  b.socket.receive({ type: "chat", commentId: "new", clientId: "friend", name: "Friend", message: "Hello!" });
  assert.equal(b.el("socialChatUnread").textContent, "1");
  assert.equal(b.el("socialChatUnread").hidden, false);
  b.el("socialTabs").dispatch("keydown", { key: "Home" });
  assert.equal(b.el("socialChat").hidden, false);
  assert.equal(b.el("socialPeople").hidden, true);
  assert.equal(b.el("socialChatUnread").hidden, true);
  assert.equal(b.el("chatInput").value, "An unfinished thought");
});

test("desktop shows people and chat together and resizing preserves the selected tab", async () => {
  const b = await setup();
  b.el("peopleTab").click();
  b.window.innerWidth = 1440; b.window.dispatch("resize");
  assert.equal(b.el("socialTabs").hidden, true);
  assert.equal(b.el("socialPeople").hidden, false);
  assert.equal(b.el("socialChat").hidden, false);
  assert.equal(b.el("socialChat").getAttribute("role"), null);
  b.window.innerWidth = 390; b.window.dispatch("resize");
  assert.equal(b.el("socialChat").hidden, true);
  assert.equal(b.el("socialPeople").getAttribute("role"), "tabpanel");
});

test("fullscreen conversation restores the People tab and draft across exit", async () => {
  const b = await setup();
  b.el("peopleTab").click();
  const conversation = b.el("chatConversation"), parent = conversation.parentNode;
  b.el("chatInput").value = "Still here";
  await b.el("videoShell").requestFullscreen();
  assert.equal(conversation.parentNode, b.el("fullscreenChat"));
  await b.document.exitFullscreen();
  assert.equal(conversation.parentNode, parent);
  assert.equal(b.el("peopleTab").getAttribute("aria-selected"), "true");
  assert.equal(b.el("socialChat").hidden, true);
  assert.equal(b.el("chatInput").value, "Still here");
});

test("room and chat disclosures dismiss outside and on Escape with focus restoration", async () => {
  const b = await setup();
  b.el("roomMenuToggle").click();
  assert.equal(b.el("roomMenu").hidden, false);
  b.document.dispatch("keydown", { key: "Escape" });
  assert.equal(b.el("roomMenu").hidden, true);
  assert.equal(b.el("roomMenuToggle").focused, true);
  b.el("roomMenuToggle").click();
  b.el("chatMenuToggle").click();
  assert.equal(b.el("roomMenu").hidden, true);
  assert.equal(b.el("chatMenu").hidden, false);
  b.document.dispatch("pointerdown", { target: b.el("videoShell") });
  assert.equal(b.el("chatMenu").hidden, true);
  b.el("roomInfoToggle").click();
  b.el("roomMenuToggle").click();
  assert.equal(b.el("roomInfoDetails").hidden, true);
});

test("profile feedback stays in room options while People is selected", async () => {
  const b = await setup();
  b.el("peopleTab").click(); b.el("roomMenuToggle").click();
  b.el("displayNameInput").value = "Friend";
  b.el("nameForm").dispatch("submit");
  assert.equal(b.el("displayNameInput").focused, true);
  assert.equal(b.el("nameStatus").textContent, "Saving name…");
  b.socket.receive({ type: "name-rejected", name: "Me", message: "Already used" });
  assert.equal(b.el("nameStatus").textContent, "Already used");
  assert.equal(b.el("roomMenu").hidden, false);
  assert.equal(b.el("socialChat").hidden, true);
  b.socket.receive({ type: "name-updated", name: "Another friend" });
  assert.match(b.el("nameStatus").textContent, /Another friend/);
});
