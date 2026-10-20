const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createSession } = require("../server/state");
const { createMessageHandler } = require("../server/messages");
const { DEFAULT_PERMISSIONS, permissionsFor, promoteHost } = require("../server/permissions");
const { createApplication } = require("../server/application");
const { CPU_ENCODER } = require("../server/encoders");
const { connectPeer } = require("./helpers/peer");
const { createBrowserDouble } = require("./helpers/browser");
const flush = () => new Promise(resolve => setImmediate(resolve));
const all = { playPause: true, seek: true, playbackRate: true };

function handlerFixture() {
  const state = createSession(), sent = [], broadcasts = [];
  state.hostId = "host";
  state.clients.set("host", { role: "host", name: "Host" });
  state.clients.set("viewer", { role: "viewer", name: "Viewer", permissionIdentity: "browser:viewer" });
  state.clients.set("other", { role: "viewer", name: "Other" });
  state.mediaPath = "movie.mkv"; state.mediaReady = true; state.mediaDuration = 100;
  state.playback.time = 10;
  let restarts = 0;
  const handler = createMessageHandler({ state,
    transport: { send: (ws, message) => sent.push(message), broadcast: message => broadcasts.push(message) },
    media: { restartStream() { restarts++; } } });
  const message = (id, value) => handler.handleMessage({ clientId: id }, value);
  const grant = permissions => message("host", { type: "set-viewer-permissions", clientId: "viewer", permissions });
  return { state, sent, broadcasts, message, grant, restarts: () => restarts };
}

test("only the current host may edit valid permissions for a connected viewer", () => {
  const f = handlerFixture();
  for (const [id, target, permissions] of [
    ["viewer", "viewer", all], ["host", "host", all], ["host", "missing", all],
    ["host", "viewer", { ...all, seek: "true" }], ["host", "viewer", { seek: true }],
    ["host", "viewer", { ...all, admin: true }]
  ]) {
    f.message(id, { type: "set-viewer-permissions", clientId: target, permissions });
    assert.equal(f.sent.at(-1).action, "set-viewer-permissions");
    assert.equal(f.state.viewerPermissions.size, 0);
  }
  f.grant(all);
  assert.deepEqual(f.broadcasts.at(-1), { type: "permissions-updated", clientId: "viewer", permissions: all });
  assert.deepEqual(permissionsFor(f.state, f.state.clients.get("other"), "other"), DEFAULT_PERMISSIONS);
  assert.deepEqual(permissionsFor(f.state, f.state.clients.get("host"), "host"), all);
});

test("viewer commands change only the authorized part of shared playback", () => {
  const f = handlerFixture();
  f.grant({ playPause: false, seek: true, playbackRate: false });
  f.message("viewer", { type: "video-state", syncMode: "seek", time: 60, paused: false, playbackRate: 4, commandSequence: 1 });
  assert.equal(f.state.playback.time, 60);
  assert.equal(f.state.playback.paused, true);
  assert.equal(f.state.playback.rate, 1);
  assert.equal(f.restarts(), 1);
  assert.equal(f.broadcasts.at(-1).commandClientId, "viewer");
  assert.equal(f.broadcasts.at(-1).seekSequence, 1);
  assert.equal(f.state.playbackRevision, 1);
  f.grant({ playPause: false, seek: false, playbackRate: true });
  f.message("viewer", { type: "video-state", syncMode: "rate", time: 90, paused: false, playbackRate: 1.5, commandSequence: 2 });
  assert.equal(f.state.playback.time, 60);
  assert.equal(f.state.playback.paused, true);
  assert.equal(f.state.playback.rate, 1.5);
  f.grant(DEFAULT_PERMISSIONS);
  f.message("viewer", { type: "video-state", syncMode: "play", time: 90, playbackRate: 4 });
  assert.equal(f.state.playback.time, 60);
  assert.equal(f.state.playback.rate, 1.5);
  assert.equal(f.state.playback.paused, false);
});

test("revoked controls, viewer ticks, and forged modes return correction without changing the clock", () => {
  const f = handlerFixture();
  f.grant({ playPause: false, seek: false, playbackRate: false });
  for (const syncMode of ["play", "pause", "seek", "rate", "tick", "source", "toString", "__proto__"]) {
    f.message("viewer", { type: "video-state", syncMode, time: 99, playbackRate: 4, commandSequence: 7 });
    assert.equal(f.sent.at(-1).type, "playback-rejected");
    assert.equal(f.sent.at(-1).commandSequence, 7);
    assert.equal(f.sent.at(-1).state.syncMode, "correction");
    assert.equal(f.state.playback.time, 10);
    assert.equal(f.state.playback.rate, 1);
  }
  assert.equal(f.restarts(), 0);
});

test("one browser shares room grants and promotion clears them only for that browser", () => {
  const f = handlerFixture();
  f.state.clients.set("second-tab", { role: "viewer", permissionIdentity: "browser:viewer" });
  f.grant(all);
  assert.deepEqual(f.broadcasts.filter(m => m.type === "permissions-updated").map(m => m.clientId), ["viewer", "second-tab"]);
  promoteHost(f.state, "other");
  assert.equal(f.state.viewerPermissions.size, 1, "another host taking over retains grants");
  promoteHost(f.state, "viewer");
  assert.equal(f.state.viewerPermissions.size, 0);
  assert.deepEqual(permissionsFor(f.state, f.state.clients.get("second-tab"), "second-tab"), DEFAULT_PERMISSIONS);
});

async function serverFixture(t, config = {}) {
  const app = createApplication({ config: { port: 0, ...config }, encoderPromise: Promise.resolve(CPU_ENCODER) });
  const address = await app.listen(); t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  const api = async (path, body = {}, cookie = "", headers = {}) => {
    const response = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, ...headers }, body: JSON.stringify(body) });
    return { response, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const connect = async (path = "/", cookie = "", name = "Viewer") => {
    const peer = await connectPeer(base.replace("http", "ws") + path, name, { headers: { Cookie: cookie } });
    t.after(() => peer.ws.terminate()); return peer;
  };
  const grant = async (host, viewer, permissions = all) => {
    host.send({ type: "set-viewer-permissions", clientId: viewer.role.clientId, permissions });
    return viewer.next("permissions-updated", m => m.clientId === viewer.role.clientId);
  };
  const close = async peer => { const done = once(peer.ws, "close"); peer.ws.close(); await done; };
  return { app, base, api, connect, grant, close };
}

test("signed browser identity is persistent, origin checked, HTTPS aware, and renewed after server restart", async t => {
  const f = await serverFixture(t, { trustProxy: "loopback" });
  const first = await f.api("/api/viewer-identity", {}, "", { "x-forwarded-proto": "https" });
  assert.match(first.response.headers.get("set-cookie"), /Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure/);
  const second = await f.api("/api/viewer-identity", {}, first.cookie);
  assert.equal(second.cookie, first.cookie);
  const changed = await f.api("/api/viewer-identity", {}, first.cookie + "tampered");
  assert.notEqual(changed.cookie, first.cookie);
  assert.equal((await f.api("/api/viewer-identity", {}, "", { Origin: "https://elsewhere.example" })).response.status, 403);
  assert.equal((await fetch(f.base + "/api/viewer-identity")).status, 405);
  const restarted = await serverFixture(t);
  assert.notEqual((await restarted.api("/api/viewer-identity", {}, first.cookie)).cookie, first.cookie);
});

test("public room grants survive reconnects, renames, and another host taking over", async t => {
  const f = await serverFixture(t);
  const host = await f.connect("/", "", "Host");
  const successor = await f.connect("/", "", "Successor");
  const identity = (await f.api("/api/viewer-identity")).cookie;
  let viewer = await f.connect("/", identity);
  assert.deepEqual(viewer.role.permissions, DEFAULT_PERMISSIONS);
  await f.grant(host, viewer);
  viewer.send({ type: "set-name", name: "Renamed" }); await viewer.next("name-updated");
  await f.close(viewer);
  viewer = await f.connect("/", identity, "Rejoined");
  assert.deepEqual(viewer.role.permissions, all);
  await f.close(host); await successor.next("role", m => m.role === "host");
  const snapshot = await viewer.next("party-state", m => m.participants.some(p => p.clientId === successor.role.clientId && p.role === "host"));
  assert.deepEqual(snapshot.participants.find(p => p.clientId === viewer.role.clientId).permissions, all);
  await f.close(successor); await viewer.next("role", m => m.role === "host");
  assert.equal(f.app.state.viewerPermissions.size, 0);
});

test("private room grants survive explicit leave/rejoin without granting admission or crossing rooms", async t => {
  const f = await serverFixture(t, { roomIdleMs: 100 });
  const created = await f.api("/api/rooms", { name: "Permissions", password: "secret" });
  const host = await f.connect(created.body.endpoints.websocket, created.cookie, "Host");
  const identity = (await f.api("/api/viewer-identity")).cookie;
  const joinBody = { accessCode: created.body.room.accessCode, password: "secret" };
  let membership = await f.api("/api/rooms/join", joinBody);
  let viewer = await f.connect(membership.body.endpoints.websocket, `${membership.cookie}; ${identity}`);
  await f.grant(host, viewer);
  const left = once(viewer.ws, "close");
  await f.api(membership.body.endpoints.leave, {}, `${membership.cookie}; ${identity}`); await left;
  assert.equal((await fetch(f.base + membership.body.endpoints.session, { headers: { Cookie: `${membership.cookie}; ${identity}` } })).status, 401);
  assert.equal((await f.api("/api/rooms/join", { accessCode: joinBody.accessCode }, identity)).response.status, 401);
  membership = await f.api("/api/rooms/join", joinBody, identity);
  viewer = await f.connect(membership.body.endpoints.websocket, `${membership.cookie}; ${identity}`);
  assert.deepEqual(viewer.role.permissions, all);
  const publicHost = await f.connect("/", "", "Public host");
  const publicViewer = await f.connect("/", identity, "Public viewer");
  assert.deepEqual(publicViewer.role.permissions, DEFAULT_PERMISSIONS);
  publicHost.send({ type: "set-viewer-permissions", clientId: viewer.role.clientId, permissions: all });
  assert.equal((await publicHost.next("error")).action, "set-viewer-permissions");
  const room = f.app.rooms.get(created.body.room.id);
  await f.close(viewer); await f.close(host);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(f.app.rooms.has(room.id), false);
  assert.equal(room.state.viewerPermissions.size, 0);
});

test("participant dropdown confirms permission updates and restores focus on dismissal", async () => {
  const b = createBrowserDouble(); await b.load("js/app.js");
  const socket = b.sockets[0], el = id => b.elements.get(id);
  socket.open(); socket.receive({ type: "role", role: "host", clientId: "host" });
  assert.equal(el("participantDropdown").hidden, true);
  socket.receive({ type: "presence", count: 2, participants: [{ clientId: "viewer", role: "viewer", name: "Alex", permissions: { ...DEFAULT_PERMISSIONS } }] });
  const trigger = el("participantList").children[0].children[0]; trigger.click();
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(el("participantDropdown").parentNode, b.document.body);
  const switches = () => el("participantDetails").children.filter(child => child.className === "permission-switch").map(label => label.children[1]);
  assert.deepEqual(switches().map(input => input.checked), [true, false, false]);
  switches()[1].checked = true; switches()[1].dispatch("change");
  assert.equal(socket.sent.at(-1).type, "set-viewer-permissions");
  assert.deepEqual(socket.sent.at(-1).permissions, { ...DEFAULT_PERMISSIONS, seek: true });
  assert.equal(switches()[1].checked, false);
  assert.ok(switches().every(input => input.disabled));
  socket.receive({ type: "permissions-updated", clientId: "viewer", permissions: { ...DEFAULT_PERMISSIONS, seek: true } });
  assert.equal(switches()[1].checked, true); assert.equal(switches()[1].disabled, false);
  await flush(); assert.equal(switches()[1].focused, true);
  trigger.click(); trigger.click();
  assert.equal(switches()[1].checked, true);
  switches()[2].dispatch("change");
  socket.receive({ type: "error", action: "set-viewer-permissions", clientId: "viewer", message: "Viewer left." });
  assert.equal(switches()[2].checked, false); assert.equal(switches()[2].disabled, false);
  assert.equal(el("participantStatus").textContent, "Viewer left.");
  switches()[2].dispatch("change"); b.runTimers(10000);
  assert.match(el("participantStatus").textContent, /timed out/);
  b.document.dispatch("keydown", { key: "Escape" });
  assert.equal(el("participantDropdown").hidden, true); assert.equal(trigger.focused, true);
  socket.close(); assert.equal(el("participantDropdown").hidden, true);
  socket.receive({ type: "role", role: "viewer", clientId: "viewer" });
  trigger.click(); assert.ok(switches().every(input => input.disabled));
});

test("viewer controls change live and unauthorized local playback is restored", async () => {
  const b = createBrowserDouble(); await b.load("js/app.js");
  const socket = b.sockets[0], video = b.elements.get("video"); video.readyState = 4;
  socket.open(); socket.receive({ type: "role", role: "viewer", clientId: "viewer", permissions: DEFAULT_PERMISSIONS });
  socket.receive({ type: "session-state", hasVideo: true, mediaVersion: 1, mediaUrl: "/stream", time: 10, paused: true, playbackRate: 1, duration: 100 });
  await flush();
  assert.match(video.getAttribute("controlslist"), /noprogress/);
  socket.receive({ type: "permissions-updated", clientId: "viewer", permissions: all });
  assert.doesNotMatch(video.getAttribute("controlslist"), /noprogress|nospeed|noplay\s/);
  video.currentTime = 40; video.dispatch("seeking");
  assert.equal(socket.sent.at(-1).syncMode, "seek");
  const sequence = socket.sent.at(-1).commandSequence;
  socket.receive({ type: "permissions-updated", clientId: "viewer", permissions: { playPause: false, seek: false, playbackRate: false } });
  socket.receive({ type: "playback-rejected", commandSequence: sequence, message: "Revoked", state: { type: "session-state", hasVideo: true, mediaVersion: 1, mediaUrl: "/stream", time: 10, paused: true, playbackRate: 1, duration: 100, syncMode: "correction" } });
  await flush(); assert.equal(video.currentTime, 10);
  const count = socket.sent.length;
  video.currentTime = 80; video.dispatch("seeking"); await flush();
  assert.equal(video.currentTime, 10); assert.equal(socket.sent.length, count);
  await video.play(); await flush(); assert.equal(video.paused, true);
  assert.match(video.getAttribute("controlslist"), /nocenterplay/);
  socket.receive({ type: "permissions-updated", clientId: "viewer", permissions: all });
  video.dispatch("keydown", { key: "k" }); await flush();
  assert.equal(socket.sent.at(-1).syncMode, "play");
});

test("viewer speed reaches host playback and external seeks cannot impersonate a pending acknowledgement", async () => {
  const b = createBrowserDouble(); const { createPlaybackSync } = await b.load("js/player/sync.js");
  const video = b.elements.get("video"); video.readyState = 4;
  const state = { role: "host", clientId: "host", mediaVersion: 1, playbackRevision: 0, activeMediaUrl: "/stream" };
  const sync = createPlaybackSync({ elements: { video, syncStatus: b.elements.get("syncStatus") }, state, send() {} });
  sync.apply({ mediaVersion: 1, syncMode: "rate", time: 0, playbackRate: 1.5, paused: true }, false);
  await flush(); assert.equal(video.playbackRate, 1.5);
  sync.broadcast("seek", 40); sync.broadcast("seek", 80);
  assert.equal(sync.accept({ mediaVersion: 1, playbackRevision: 0, syncMode: "seek", seekSequence: 100, commandClientId: "other" }), false);
  assert.equal(sync.accept({ mediaVersion: 1, playbackRevision: 1, syncMode: "seek", seekSequence: 1, commandClientId: "other" }), true);
  assert.equal(sync.accept({ mediaVersion: 1, playbackRevision: 2, syncMode: "seek", seekSequence: 2, commandClientId: "host" }), true);
  sync.apply({ mediaVersion: 1, syncMode: "seek", time: 80, paused: true, playbackRate: 1.5 }, false);
  assert.equal(video.currentTime, 80);
});

test("identity bootstrap fails visibly before opening a control socket", async () => {
  const b = createBrowserDouble(); b.context.fetch = async () => ({ ok: false });
  await assert.rejects(b.load("js/app.js"), /establish viewer identity/);
  assert.equal(b.sockets.length, 0);
  assert.match(b.elements.get("connectionStatus").textContent, /establish viewer identity/);
});

test("delayed native rate events from drift correction never change shared speed", async () => {
  const b = createBrowserDouble(); const { createPlaybackSync } = await b.load("js/player/sync.js");
  const video = b.elements.get("video"); video.readyState = 4;
  const state = { role: "viewer", permissions: all, mediaVersion: 1, activeMediaUrl: "/stream" };
  const sent = [];
  const sync = createPlaybackSync({ elements: { video, syncStatus: b.elements.get("syncStatus") }, state, send: message => sent.push(message) });
  sync.apply({ mediaVersion: 1, syncMode: "tick", time: .5, paused: false, playbackRate: 1.5 }, false);
  await flush(); assert.equal(sync.isApplying(), false);
  assert.equal(video.playbackRate, 1.55);
  sync.broadcast("rate"); assert.equal(sent.length, 0);
  video.playbackRate = 2; sync.broadcast("rate");
  assert.equal(sent.at(-1).playbackRate, 2);
});

test("a permitted speed change queued behind a seek is sent after acknowledgement", async () => {
  const b = createBrowserDouble(); const { createPlaybackSync } = await b.load("js/player/sync.js");
  const video = b.elements.get("video"); video.readyState = 4;
  const state = { role: "viewer", clientId: "viewer", permissions: all, mediaVersion: 1, playbackRevision: 0, activeMediaUrl: "/stream" };
  const sent = [];
  const sync = createPlaybackSync({ elements: { video, syncStatus: b.elements.get("syncStatus") }, state, send: message => sent.push(message) });
  sync.broadcast("seek", 20); video.playbackRate = 2; sync.broadcast("rate");
  assert.equal(sent.length, 1);
  const ack = { mediaVersion: 1, playbackRevision: 1, syncMode: "seek", seekSequence: 1, commandClientId: "viewer", time: 20, paused: true, playbackRate: 1 };
  assert.equal(sync.accept(ack), true); sync.apply(ack, false); await flush();
  assert.equal(sent.at(-1).syncMode, "rate"); assert.equal(sent.at(-1).playbackRate, 2);
  assert.equal(sent.at(-1).playbackRevision, 1);
});

test("HLS user seeks respect permissions while internal recovery stays local", async () => {
  const b = createBrowserDouble(); await b.load("js/app.js");
  const socket = b.sockets[0], video = b.elements.get("video"), native = b.document.createElement("video"), seeks = [];
  Object.assign(native, { currentTime: 10, paused: true, readyState: 4, playbackRate: 1 });
  video.player = { getHLSVideoElement: () => native, seek(time) { seeks.push(time); native.currentTime = time; } };
  socket.open(); socket.receive({ type: "role", role: "viewer", clientId: "viewer", permissions: DEFAULT_PERMISSIONS });
  socket.receive({ type: "session-state", hasVideo: true, mediaVersion: 1, mediaUrl: "/stream", time: 10, paused: true, playbackRate: 1, duration: 100 });
  video.dispatch("loadedmetadata"); await flush();
  video.player.seek(40);
  assert.deepEqual(seeks, []);
  assert.equal(socket.sent.filter(message => message.type === "video-state").length, 0);
  await flush(); video.player.seek(8, { internal: true });
  assert.deepEqual(seeks, [8]);
  assert.equal(socket.sent.filter(message => message.type === "video-state").length, 0);
  socket.receive({ type: "permissions-updated", clientId: "viewer", permissions: all });
  video.player.seek(30);
  assert.deepEqual(seeks, [8, 30]);
  assert.equal(socket.sent.at(-1).syncMode, "seek"); assert.equal(socket.sent.at(-1).time, 30);
});
