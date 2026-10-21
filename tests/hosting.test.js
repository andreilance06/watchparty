const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { randomUUID } = require("node:crypto");
const { createConfig } = require("../server/config");
const { createSession } = require("../server/state");
const { createHosting, hostStatus } = require("../server/hosting");
const { createApplication } = require("../server/application");
const { CPU_ENCODER } = require("../server/encoders");
const { connectPeer } = require("./helpers/peer");
const { createBrowserDouble } = require("./helpers/browser");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function timerFixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const state = createSession(), messages = [];
  const room = { state, transport: { send: (ws, message) => messages.push({ to: ws.clientId, ...message }), broadcast: message => messages.push(message) } };
  const add = (id, identity = `browser:${id}`) => {
    const client = { ws: { clientId: id, readyState: 1 }, name: id, role: "viewer", permissionIdentity: identity };
    state.clients.set(id, client); return client;
  };
  const hosting = createHosting(room, { config: { hostReconnectGraceMs: 15000 }, scheduleExpiry() {} });
  const host = add("host"), viewer = add("viewer");
  hosting.assign("host"); messages.length = 0;
  const disconnect = id => { const client = state.clients.get(id); state.clients.delete(id); hosting.disconnect(id, client); };
  return { state, hosting, add, host, viewer, messages, disconnect };
}

test("host reconnect grace defaults to fifteen seconds and rejects invalid configuration", () => {
  assert.equal(createConfig().hostReconnectGraceMs, 15000);
  for (const value of [-1, Infinity, NaN, "15000"]) assert.throws(() => createConfig({ hostReconnectGraceMs: value }), /non-negative number/);
});

test("host reservation lasts fifteen seconds, then hands off once without accepting a late noncreator claim", t => {
  const f = timerFixture(t);
  f.disconnect("host");
  assert.equal(f.state.hostId, "host");
  assert.equal(f.state.hostReconnectUntil, Date.now() + 15000);
  assert.deepEqual(hostStatus(f.state), { clientId: "host", name: "host", status: "reconnecting", reconnectUntil: Date.now() + 15000 });
  t.mock.timers.tick(14999);
  assert.equal(f.viewer.role, "viewer");
  t.mock.timers.tick(1);
  assert.equal(f.state.hostId, "viewer");
  assert.equal(f.viewer.role, "host");
  assert.equal(f.messages.filter(message => message.type === "host-left").length, 1);
  f.add("late-host", "browser:host"); f.hosting.connect("late-host", null);
  assert.equal(f.state.clients.get("late-host").role, "viewer");
  assert.equal(f.state.hostId, "viewer");
  t.mock.timers.tick(30000);
  assert.equal(f.messages.filter(message => message.type === "host-left").length, 1);
});

test("reconnect, creator takeover, explicit handoff, and shutdown cancel obsolete host timers", t => {
  const f = timerFixture(t);
  f.disconnect("host"); t.mock.timers.tick(14900);
  f.add("returned", "browser:host"); f.hosting.connect("returned", null);
  assert.equal(f.state.hostId, "returned");
  assert.equal(f.state.hostReconnectUntil, null);
  t.mock.timers.tick(20000);
  assert.equal(f.state.hostId, "returned");
  assert.equal(f.messages.some(message => message.type === "host-left"), false);
  f.disconnect("returned");
  f.state.creatorIdentity = "browser:creator";
  f.add("creator", "browser:creator"); f.hosting.connect("creator", null);
  t.mock.timers.tick(20000);
  assert.equal(f.state.hostId, "creator");
  f.disconnect("creator"); f.hosting.release("creator");
  assert.equal(f.state.hostId, "viewer");
  t.mock.timers.tick(20000);
  assert.equal(f.state.hostId, "viewer");
  f.disconnect("viewer"); f.state.shuttingDown = true; f.hosting.cancel();
  const count = f.messages.length;
  t.mock.timers.tick(20000);
  assert.equal(f.messages.length, count);
  assert.equal(f.state.hostReconnectUntil, null);
});

async function fixture(t, config = {}) {
  const app = createApplication({ config: { host: "127.0.0.1", port: 0, hostReconnectGraceMs: 500, ...config }, encoderPromise: Promise.resolve(CPU_ENCODER) });
  const address = await app.listen(); t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  const api = async (path, body = {}, cookie = "") => {
    const response = await fetch(base + path, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.ok(response.ok, `HTTP ${response.status} for ${path}`);
    return { body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const identity = async () => (await api("/api/viewer-identity")).cookie;
  const connect = async (cookie = "", path = "/", name = "Guest") => {
    const peer = await connectPeer(base.replace("http", "ws") + path, name, { headers: { Cookie: cookie } });
    t.after(() => peer.ws.terminate()); return peer;
  };
  const close = async peer => { const done = once(peer.ws, "close"); peer.ws.close(); await done; };
  const action = async (peer, type, clientId, rejected = false) => {
    const requestId = randomUUID(); peer.send({ type, clientId, requestId });
    return peer.next(rejected ? "error" : "participant-action-complete", message => message.requestId === requestId);
  };
  const create = async (cookie = "") => {
    const result = await api("/api/rooms", { name: "Host continuity", displayName: "Creator" }, cookie);
    return { ...result, cookie: [cookie, result.cookie].filter(Boolean).join("; ") };
  };
  const join = async (room, cookie, displayName) => {
    const result = await api(`/rooms/${room.body.room.id}/api/join`, { accessCode: room.body.room.accessCode, displayName }, cookie);
    return { ...result, cookie: [cookie, result.cookie].filter(Boolean).join("; ") };
  };
  const assertOneHost = state => assert.equal([...state.clients.values()].filter(client => client.role === "host").length, 1);
  return { app, api, identity, connect, close, action, create, join, assertOneHost };
}

test("public host refresh restores verified identity while other clients cannot impersonate it", async t => {
  const f = await fixture(t);
  const cookie = await f.identity();
  const host = await f.connect(cookie, "/", "Host"), viewer = await f.connect(await f.identity(), "/", "Viewer");
  await f.close(host);
  const waiting = await viewer.next("party-state", message => message.host.status === "reconnecting");
  assert.equal(waiting.host.clientId, host.role.clientId);
  assert.ok(waiting.host.reconnectUntil > Date.now());
  assert.equal(JSON.stringify(waiting).includes("browser:"), false);
  viewer.send({ type: "join", clientId: host.role.clientId, role: "host", name: "Impostor" });
  assert.equal((await viewer.next("role")).role, "viewer");
  viewer.send({ type: "start-video-poll" });
  assert.match((await viewer.next("error")).message, /current host/);
  const returned = await f.connect(cookie, "/", "Host returned");
  assert.equal(returned.role.role, "host");
  assert.notEqual(returned.role.clientId, host.role.clientId);
  const restored = await viewer.next("party-state", message => message.host.clientId === returned.role.clientId);
  assert.equal(restored.host.status, "connected");
  assert.equal(restored.host.reconnectUntil, null);
  f.assertOneHost(f.app.state);
  assert.equal(viewer.messages.some(message => message.type === "host-left"), false);
});

test("creator reclaims sole hosting after timeout and after explicit leave/rejoin", async t => {
  const f = await fixture(t, { hostReconnectGraceMs: 30 });
  const creatorIdentity = await f.identity(), room = await f.create(creatorIdentity);
  const membership = await f.join(room, await f.identity(), "Successor");
  const host = await f.connect(room.cookie, room.body.endpoints.websocket);
  const successor = await f.connect(membership.cookie, room.body.endpoints.websocket);
  const state = f.app.rooms.get(room.body.room.id).state;
  await f.close(host);
  await successor.next("role", message => message.role === "host");
  const returned = await f.connect(room.cookie, room.body.endpoints.websocket);
  assert.equal(returned.role.role, "host");
  await successor.next("role", message => message.role === "viewer");
  f.assertOneHost(state);
  await f.api(room.body.endpoints.leave, {}, room.cookie);
  await successor.next("role", message => message.role === "host");
  assert.equal(state.hostReconnectUntil, null);
  const rejoinedMembership = await f.join(room, creatorIdentity, "Creator rejoined");
  const rejoined = await f.connect(rejoinedMembership.cookie, room.body.endpoints.websocket);
  assert.notEqual(rejoined.role.clientId, returned.role.clientId);
  assert.equal(rejoined.role.role, "host");
  await successor.next("role", message => message.role === "viewer");
  f.assertOneHost(state);
});

test("explicit transfer is immediate, creator is protected, and replacement sockets cannot create extra hosts", async t => {
  const f = await fixture(t);
  const room = await f.create(await f.identity());
  const membership = await f.join(room, await f.identity(), "Successor");
  const host = await f.connect(room.cookie, room.body.endpoints.websocket);
  const successor = await f.connect(membership.cookie, room.body.endpoints.websocket);
  const state = f.app.rooms.get(room.body.room.id).state;
  await f.action(host, "transfer-host", successor.role.clientId);
  assert.equal(state.hostId, successor.role.clientId);
  assert.equal(state.hostReconnectUntil, null);
  assert.match((await f.action(successor, "block-participant", host.role.clientId, true)).message, /creator cannot be blocked/);
  const replaced = once(host.ws, "close");
  const returned = await f.connect(room.cookie, room.body.endpoints.websocket);
  assert.equal((await replaced)[0], 4000);
  assert.equal(returned.role.role, "host");
  assert.equal(state.hostId, returned.role.clientId);
  assert.equal(state.hostReconnectUntil, null);
  f.assertOneHost(state);
});

test("private host refresh restores the authenticated original membership without a browser cookie", async t => {
  const f = await fixture(t);
  const room = await f.create();
  const host = await f.connect(room.cookie, room.body.endpoints.websocket);
  const viewerMembership = await f.join(room, await f.identity(), "Viewer");
  const viewer = await f.connect(viewerMembership.cookie, room.body.endpoints.websocket);
  await f.close(host);
  await viewer.next("party-state", message => message.host.status === "reconnecting");
  const returned = await f.connect(room.cookie, room.body.endpoints.websocket);
  assert.equal(returned.role.role, "host");
  assert.equal(returned.role.clientId, host.role.clientId);
  assert.equal(viewer.messages.some(message => message.type === "host-left"), false);
});

test("host reservations defer idle expiry and are scoped to their room", async t => {
  const f = await fixture(t, { hostReconnectGraceMs: 400, roomIdleMs: 100 });
  const first = await f.create(await f.identity());
  const host = await f.connect(first.cookie, first.body.endpoints.websocket);
  const second = await f.create(await f.identity());
  const other = await f.connect(second.cookie, second.body.endpoints.websocket);
  await f.close(host);
  await sleep(150);
  assert.ok(f.app.rooms.has(first.body.room.id));
  assert.equal(f.app.rooms.get(second.body.room.id).state.hostId, other.role.clientId);
  assert.equal(f.app.rooms.get(second.body.room.id).state.hostReconnectUntil, null);
  for (let n = 0; n < 20 && f.app.rooms.has(first.body.room.id); n++) await sleep(50);
  assert.equal(f.app.rooms.has(first.body.room.id), false);
  assert.ok(f.app.rooms.has(second.body.room.id));
});

test("explicit leave while the host is offline cancels its reservation and hands off immediately", async t => {
  const f = await fixture(t);
  const room = await f.create(await f.identity());
  const membership = await f.join(room, await f.identity(), "Viewer");
  const host = await f.connect(room.cookie, room.body.endpoints.websocket);
  const viewer = await f.connect(membership.cookie, room.body.endpoints.websocket);
  await f.close(host);
  await viewer.next("party-state", message => message.host.status === "reconnecting");
  await f.api(room.body.endpoints.leave, {}, room.cookie);
  await viewer.next("role", message => message.role === "host");
  const state = f.app.rooms.get(room.body.room.id).state;
  assert.equal(state.hostId, viewer.role.clientId);
  assert.equal(state.hostReconnectUntil, null);
});

test("poll attribution follows accepted names across rejoining and completed results stay frozen", async t => {
  const f = await fixture(t);
  const room = await f.create(await f.identity()), browser = await f.identity();
  const membership = await f.join(room, browser, "Before");
  const host = await f.connect(room.cookie, room.body.endpoints.websocket);
  const viewer = await f.connect(membership.cookie, room.body.endpoints.websocket);
  host.send({ type: "start-video-poll" });
  const { poll: { id: pollId } } = await host.next("party-state", message => message.poll.status === "open");
  viewer.send({ type: "suggest-video", pollId, title: "Arrival" });
  await host.next("party-state", message => message.suggestions.length === 1);
  viewer.send({ type: "set-name", name: "After" });
  await host.next("party-state", message => message.suggestions[0]?.ownerName === "After");
  await f.close(viewer);
  const rejoinedMembership = await f.join(room, browser, "Returned");
  const returned = await f.connect(rejoinedMembership.cookie, room.body.endpoints.websocket);
  assert.notEqual(returned.role.clientId, viewer.role.clientId);
  const joined = await host.next("party-state", message => message.suggestions[0]?.ownerName === "Returned");
  assert.equal(joined.suggestions[0].ownerId, viewer.role.clientId);
  returned.send({ type: "set-name", name: "Current" });
  await host.next("party-state", message => message.suggestions[0]?.ownerName === "Current");
  returned.send({ type: "set-name", name: "Creator" });
  await returned.next("name-rejected");
  assert.equal(f.app.rooms.get(room.body.room.id).state.videoSuggestions[0].ownerName, "Current");
  host.send({ type: "finish-video-poll", pollId });
  await host.next("party-state", message => message.poll.status === "closed");
  returned.send({ type: "set-name", name: "Later" });
  const completed = await host.next("party-state", message => message.participants.some(person => person.name === "Later"));
  assert.equal(completed.poll.result.suggestions[0].ownerName, "Current");
});

test("host reconnect notice is hydrated for joining viewers and cleared on restoration or handoff", async () => {
  const b = createBrowserDouble(); await b.load("js/app.js");
  const socket = b.sockets[0]; socket.open();
  socket.receive({ type: "party-state", host: { clientId: "host", name: "Alex", status: "reconnecting", reconnectUntil: Date.now() + 15000 } });
  const notice = b.elements.get("hostReconnectStatus");
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /Alex is reconnecting/);
  socket.receive({ type: "party-state", host: { clientId: "host", name: "Alex", status: "connected", reconnectUntil: null } });
  assert.equal(notice.hidden, true);
  assert.equal(notice.textContent, "");
  socket.receive({ type: "party-state", host: { clientId: "next", name: "Sam", status: "connected", reconnectUntil: null } });
  assert.equal(notice.hidden, true);
});

test("participant controls allow returning hosting to the creator without offering to block them", async () => {
  const b = createBrowserDouble(); await b.load("js/app.js");
  const socket = b.sockets[0]; socket.open();
  socket.receive({ type: "role", role: "host", clientId: "temporary-host" });
  socket.receive({ type: "presence", count: 2, participants: [{ clientId: "creator", name: "Creator", role: "viewer", isCreator: true, suppliesVideo: true }] });
  b.elements.get("participantList").children[0].children[0].click();
  const actions = b.elements.get("participantDetails").children.at(-1);
  assert.deepEqual(actions.children.map(button => button.textContent), ["Transfer host"]);
});
