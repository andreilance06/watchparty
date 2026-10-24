const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrowserDouble } = require("./helpers/browser");

async function setup({ audioState = "running", resumeFails = false, audioThrows = false } = {}) {
  const browser = createBrowserDouble();
  const el = id => browser.elements.get(id);
  let now = 0;
  browser.context.performance = { now: () => now };
  const audio = { created: 0, played: 0, resumes: 0, disconnected: 0 };
  browser.window.AudioContext = class {
    constructor() {
      if (audioThrows) throw new Error("Audio blocked");
      audio.created++;
      this.state = audioState;
      this.currentTime = 0;
      audio.instance = this;
    }
    async resume() {
      audio.resumes++;
      if (resumeFails) throw new Error("Audio blocked");
      this.state = "running";
    }
    createOscillator() {
      const node = { frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {}, disconnect() { audio.disconnected++; },
        start() { audio.played++; }, stop() { node.onended(); } };
      return node;
    }
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {}, disconnect() { audio.disconnected++; } };
    }
  };
  await browser.load("js/app.js");
  const socket = browser.sockets[0];
  socket.open();
  socket.receive({ type: "role", clientId: "self", name: "Me", role: "host" });
  const add = (commentId, extra = {}) => socket.receive({ type: "chat", commentId,
    clientId: "other", name: "Friend", message: commentId, ...extra });
  return { ...browser, el, socket, add, audio, advance: ms => { now += ms; } };
}

const badge = browser => browser.el("fullscreenChatUnread");
const toggle = browser => browser.el("fullscreenChatToggle");
const hide = async browser => {
  await browser.el("videoShell").requestFullscreen();
  toggle(browser).click();
};

test("fullscreen chat preference survives native, WebKit and fallback transitions until reload", async () => {
  const b = await setup();
  await hide(b);
  await b.document.exitFullscreen();
  assert.equal(b.el("chatConversation").parentNode, b.el("chatPanel"));
  await b.el("videoShell").requestFullscreen();
  assert.equal(b.el("fullscreenChat").hidden, true);
  assert.equal(toggle(b).getAttribute("aria-expanded"), "false");
  await b.document.exitFullscreen();
  const shell = b.el("videoShell");
  shell.requestFullscreen = undefined;
  shell.webkitRequestFullscreen = () => {
    b.document.webkitFullscreenElement = shell;
    b.document.dispatch("webkitfullscreenchange");
  };
  b.el("video").dispatch("movi-fullscreen-request");
  assert.equal(b.el("fullscreenChat").hidden, true);
  b.document.webkitFullscreenElement = null;
  b.document.dispatch("webkitfullscreenchange");
  shell.webkitRequestFullscreen = undefined;
  b.el("video").dispatch("movi-fullscreen-request");
  assert.equal(shell.classList.contains("pseudo-fullscreen"), true);
  assert.equal(b.el("fullscreenChat").hidden, true);
  toggle(b).click();
  b.document.dispatch("keydown", { key: "Escape" });
  b.el("video").dispatch("movi-fullscreen-request");
  assert.equal(b.el("fullscreenChat").hidden, false);
  const fresh = await setup();
  await fresh.el("videoShell").requestFullscreen();
  assert.equal(fresh.el("fullscreenChat").hidden, false);
});

test("unread badge reveals for four seconds, restarts on messages and follows controls again", async () => {
  const b = await setup();
  await hide(b);
  b.el("video").dispatch("controlschange", { detail: { visible: false } });
  assert.equal(toggle(b).classList.contains("is-idle"), true);
  b.add("one");
  assert.equal(badge(b).textContent, "1");
  assert.equal(badge(b).hidden, false);
  assert.equal(toggle(b).classList.contains("is-idle"), false);
  const first = [...b.timers].find(([, timer]) => timer.delay === 4000)[0];
  b.add("two");
  assert.equal(b.timers.has(first), false, "A new message replaces the old reveal timer");
  assert.equal(badge(b).textContent, "2");
  b.runTimers(4000);
  assert.equal(toggle(b).classList.contains("is-idle"), true);
  b.el("video").dispatch("controlschange", { detail: { visible: true } });
  assert.equal(toggle(b).classList.contains("is-idle"), false);
  assert.match(toggle(b).getAttribute("aria-label"), /2 unread messages/);
  toggle(b).click();
  assert.equal(badge(b).hidden, true);
});

test("hidden scrollers reporting zero preserve older reading through fullscreen exit and reentry", async () => {
  const b = await setup();
  const messages = b.el("chatMessages");
  let scrollTop = 120;
  const hidden = () => messages.parentNode.parentNode === b.el("fullscreenChat") && b.el("fullscreenChat").hidden;
  const rect = messages.getBoundingClientRect.bind(messages);
  messages.getBoundingClientRect = () => hidden() ? { height: 0, width: 0 } : rect();
  Object.defineProperty(messages, "scrollTop", {
    get: () => hidden() ? 0 : scrollTop,
    set: value => { if (!hidden()) scrollTop = value; }
  });
  for (let i = 0; i < 30; i++) b.add(`older-${i}`);
  messages.scrollTop = 120;
  messages.dispatch("scroll");
  await hide(b);
  messages.dispatch("scroll");
  b.add("hidden-message");
  assert.equal(messages.scrollTop, 0);
  await b.document.exitFullscreen();
  assert.equal(messages.scrollTop, 120);
  await b.el("videoShell").requestFullscreen();
  assert.equal(b.el("fullscreenChat").hidden, true);
  toggle(b).click();
  assert.equal(messages.scrollTop, 120);
  assert.equal(badge(b).hidden, false, "Older reading keeps the new message unread");
  b.el("chatJumpLatest").click();
  assert.equal(badge(b).hidden, true);
  toggle(b).click();
  b.add("follow-hidden");
  toggle(b).click();
  assert.equal(messages.scrollTop, messages.scrollHeight, "Following the latest resumes after hidden arrivals");
  assert.equal(badge(b).hidden, true);
});

test("unread clears only with focused chat at the latest messages, including on returning from fullscreen", async () => {
  const b = await setup();
  for (let i = 0; i < 25; i++) b.add(`old-${i}`);
  b.el("chatMessages").scrollTop = 0;
  b.el("chatMessages").dispatch("scroll");
  await hide(b);
  b.add("hidden");
  toggle(b).click();
  assert.equal(badge(b).textContent, "1", "Opening older chat does not mark messages read");
  assert.equal(badge(b).hidden, false);
  b.window.dispatch("blur");
  b.el("chatJumpLatest").click();
  assert.equal(badge(b).hidden, false, "Scrolling while unfocused does not mark messages read");
  b.window.dispatch("focus");
  assert.equal(badge(b).hidden, true);
  toggle(b).click();
  b.add("hidden-again");
  assert.equal(badge(b).hidden, false);
  await b.document.exitFullscreen();
  assert.equal(badge(b).hidden, true, "Normal page chat at the bottom is read after exiting fullscreen");
});

test("offscreen latest messages remain unread until visible and background messages reveal on return", async () => {
  const b = await setup();
  await b.el("videoShell").requestFullscreen();
  b.el("chatMessages").getBoundingClientRect = () => ({
    top: 900, bottom: 1260, left: 0, right: 640, width: 640, height: 360
  });
  b.add("offscreen");
  assert.equal(badge(b).hidden, false);
  b.el("chatMessages").getBoundingClientRect = () => ({
    top: 0, bottom: 360, left: 0, right: 640, width: 640, height: 360
  });
  b.window.dispatch("scroll");
  assert.equal(badge(b).hidden, true);
  toggle(b).click();
  b.window.dispatch("blur");
  b.document.hidden = true;
  b.document.dispatch("visibilitychange");
  b.add("background");
  b.el("video").dispatch("controlschange", { detail: { visible: false } });
  b.runTimers(4000);
  assert.equal(toggle(b).classList.contains("is-idle"), true);
  b.document.hidden = false;
  b.document.dispatch("visibilitychange");
  b.window.dispatch("focus");
  assert.equal(toggle(b).classList.contains("is-idle"), false);
  assert.equal(badge(b).textContent, "1");
});

test("duplicates, own messages, system notices and reactions do not notify, badge caps visually", async () => {
  const b = await setup();
  await hide(b);
  b.document.dispatch("pointerdown");
  b.add("one");
  b.advance(1000);
  b.add("one");
  b.add("own", { clientId: "self" });
  b.socket.receive({ type: "host-changed", hostId: "new-host" });
  b.socket.receive({ type: "reaction", emoji: "🎉", name: "Friend" });
  b.socket.receive({ type: "comment-reaction", commentId: "one", reactions: [] });
  assert.equal(badge(b).textContent, "1");
  assert.equal(b.audio.played, 1);
  for (let i = 0; i < 100; i++) b.add(`new-${i}`);
  assert.equal(badge(b).textContent, "99+");
  assert.match(toggle(b).getAttribute("aria-label"), /101 unread messages/);
});

test("sound needs interaction, plays only hidden or unfocused and throttles bursts without replay", async () => {
  const b = await setup();
  await hide(b);
  b.add("before-gesture");
  assert.equal(b.audio.created, 0);
  b.document.dispatch("keydown", { key: "Shift" });
  assert.equal(b.audio.created, 1);
  assert.equal(b.audio.played, 0, "Unlocking does not replay missed sounds");
  b.add("hidden");
  b.add("burst");
  assert.equal(b.audio.played, 1);
  b.advance(1000);
  b.add("after-throttle");
  assert.equal(b.audio.played, 2);
  toggle(b).click();
  for (let i = 0; i < 20; i++) b.add(`visible-${i}`);
  b.el("chatMessages").scrollTop = 0;
  b.el("chatMessages").dispatch("scroll");
  b.advance(1000);
  b.add("reading-older");
  assert.equal(b.audio.played, 2);
  await b.document.exitFullscreen();
  b.window.dispatch("blur");
  b.add("unfocused-normal-page");
  assert.equal(b.audio.played, 3);
  assert.equal(b.audio.disconnected, 6);
});

test("blocked or unavailable audio leaves unread tracking operational without queued sounds", async () => {
  for (const options of [{ audioState: "suspended", resumeFails: true }, { audioThrows: true }, {}]) {
    const b = await setup(options);
    if (!Object.keys(options).length) b.window.AudioContext = undefined;
    await hide(b);
    b.document.dispatch("pointerdown");
    await Promise.resolve();
    b.add("quiet");
    assert.equal(b.audio.played, 0);
    assert.equal(badge(b).textContent, "1");
    toggle(b).click();
    assert.equal(badge(b).hidden, true);
  }
  const b = await setup({ audioState: "suspended" });
  await hide(b);
  b.document.dispatch("pointerdown");
  await Promise.resolve();
  b.add("resumed");
  assert.equal(b.audio.resumes, 1);
  assert.equal(b.audio.played, 1);
});
