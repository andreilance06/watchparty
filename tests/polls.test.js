const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createSession } = require("../server/state");
const { createMessageHandler } = require("../server/messages");
const { createApplication } = require("../server/application");
const { CPU_ENCODER } = require("../server/encoders");
const { connectPeer } = require("./helpers/peer");
const { createBrowserDouble } = require("./helpers/browser");
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const state = createSession(), latest = new Map();
  const add = (id, role = "viewer", identity = `browser:${id}`) => {
    const ws = { clientId: id };
    state.clients.set(id, { ws, role, name: id, permissionIdentity: identity });
    return ws;
  };
  const host = add("host", "host"), viewer = add("viewer");
  state.hostId = "host";
  const handler = createMessageHandler({ state, media: {}, transport: {
    send: (ws, message) => latest.set(ws.clientId, message), broadcast() {}
  } });
  const send = (ws, type, payload = {}) => handler.handleMessage(ws, { type, pollId: state.poll.id, ...payload });
  return { state, host, viewer, add, send, latest, publish: handler.updatePresence };
}

test("only the current host manages poll rounds and stale actions cannot change a new round", () => {
  const f = fixture();
  f.send(f.viewer, "suggest-video", { title: "Closed" });
  assert.equal(f.state.videoSuggestions.length, 0);
  f.send(f.viewer, "start-video-poll");
  assert.equal(f.state.poll.status, "idle");
  f.send(f.host, "start-video-poll");
  const firstId = f.state.poll.id;
  f.send(f.host, "start-video-poll");
  assert.equal(f.state.poll.id, firstId);
  assert.equal(f.latest.get("host").type, "error");
  f.send(f.viewer, "finish-video-poll");
  assert.equal(f.state.poll.status, "open");
  f.send(f.viewer, "suggest-video", { title: "First" });
  f.send(f.host, "finish-video-poll");
  const result = structuredClone(f.state.poll.result);
  f.send(f.host, "finish-video-poll");
  assert.deepEqual(f.state.poll.result, result);
  f.send(f.host, "start-video-poll");
  assert.notEqual(f.state.poll.id, firstId);
  assert.equal(f.state.poll.result, null);
  assert.equal(f.state.videoSuggestions.length, 0);
  for (const type of ["suggest-video", "vote-video", "remove-video-suggestion", "finish-video-poll"]) {
    f.send(f.host, type, { pollId: firstId, suggestionId: 1, title: "Stale" });
    assert.equal(f.latest.get("host").type, "error");
    assert.equal(f.state.poll.status, "open");
    assert.equal(f.state.videoSuggestions.length, 0);
  }
  f.state.clients.get("host").role = "viewer";
  f.state.clients.get("viewer").role = "host";
  f.state.hostId = "viewer";
  f.send(f.host, "finish-video-poll");
  assert.equal(f.state.poll.status, "open");
  f.send(f.viewer, "finish-video-poll");
  assert.equal(f.state.poll.status, "closed");
});

test("stable ownership survives connection changes, stays private, and lets the host remove any entry", () => {
  const f = fixture();
  f.send(f.host, "start-video-poll");
  f.send(f.viewer, "suggest-video", { title: "Arrival" });
  f.send(f.host, "suggest-video", { title: " arrival " });
  assert.equal(f.state.videoSuggestions[0].ownerId, "viewer");
  assert.equal(f.state.videoVotes.size, 2);
  assert.equal(f.latest.get("host").suggestions[0].canRemove, true);
  assert.equal(JSON.stringify(f.latest.get("host")).includes("browser:"), false);
  f.state.clients.delete("viewer");
  const returned = f.add("returned", "viewer", "browser:viewer");
  const other = f.add("other");
  f.state.clients.get("other").name = "viewer";
  f.publish();
  assert.equal(f.latest.get("returned").suggestions[0].canRemove, true);
  assert.equal(f.latest.get("other").suggestions[0].canRemove, false);
  f.send(other, "remove-video-suggestion", { suggestionId: 1, ownerId: "viewer" });
  assert.equal(f.state.videoSuggestions.length, 1);
  f.send(returned, "remove-video-suggestion", { suggestionId: 1 });
  assert.equal(f.state.videoSuggestions.length, 0);
  assert.equal(f.state.videoVotes.size, 0);
  f.send(returned, "suggest-video", { title: "Moonlight" });
  const id = f.state.videoSuggestions[0].id;
  f.send(f.host, "remove-video-suggestion", { suggestionId: id });
  assert.equal(f.state.videoSuggestions.length, 0);
  assert.equal(f.state.suggestionOwners.size, 0);
});

for (const scenario of ["empty", "no votes", "winner", "tie"]) {
  test(`concluded ${scenario} results remain frozen for subsequent snapshots`, () => {
    const f = fixture();
    f.send(f.host, "start-video-poll");
    if (scenario !== "empty") {
      f.send(f.host, "suggest-video", { title: "Arrival" });
      f.send(f.viewer, "suggest-video", { title: "Moonlight" });
    }
    if (scenario === "no votes") f.state.videoVotes.clear();
    if (scenario === "winner") f.send(f.viewer, "vote-video", { suggestionId: 1 });
    f.send(f.host, "finish-video-poll");
    const snapshot = structuredClone(f.state.poll);
    assert.deepEqual(snapshot.result.winnerIds, scenario === "winner" ? [1] : scenario === "tie" ? [1, 2] : []);
    assert.equal(snapshot.result.totalVotes, ["winner", "tie"].includes(scenario) ? 2 : 0);
    f.state.clients.delete("viewer");
    f.state.videoVotes.clear();
    const newcomer = f.add("newcomer");
    f.send(newcomer, "join", { name: "Newcomer" });
    assert.deepEqual(f.latest.get("newcomer").poll, snapshot);
    assert.deepEqual(f.latest.get("newcomer").suggestions, []);
  });
}

test("pinned poll controls follow lifecycle, role, collapse, connection, and result replay", async () => {
  const b = createBrowserDouble();
  await b.load("js/app.js");
  const socket = b.sockets[0], el = id => b.elements.get(id);
  socket.open();
  socket.receive({ type: "role", role: "host", clientId: "host" });
  assert.equal(el("votePanel").hidden, true);
  assert.equal(el("startPollButton").hidden, false);
  el("startPollButton").dispatch("click");
  assert.deepEqual(socket.sent.at(-1), { type: "start-video-poll" });
  const open = { type: "party-state", poll: { id: "one", status: "open", result: null }, suggestions: [] };
  socket.receive(open);
  assert.equal(el("votePanel").hidden, false);
  assert.equal(el("pollDetails").hidden, false);
  assert.equal(el("pollToggle").getAttribute("aria-expanded"), "true");
  el("pollToggle").dispatch("click");
  assert.equal(el("pollDetails").hidden, true);
  assert.equal(el("votePanel").hidden, false);
  socket.receive({ type: "role", role: "viewer", clientId: "host" });
  assert.equal(el("finishPollButton").hidden, true);
  socket.receive({ type: "role", role: "host", clientId: "host" });
  el("finishPollButton").dispatch("click");
  assert.deepEqual(socket.sent.at(-1), { type: "finish-video-poll", pollId: "one" });
  const closed = { ...open, poll: { id: "one", status: "closed", result: {
    suggestions: [{ id: 1, title: "Arrival", votes: 2 }], winnerIds: [1], totalVotes: 2
  } } };
  socket.receive(closed);
  assert.equal(el("votePanel").hidden, true);
  assert.match(el("chatMessages").children.at(-1).textContent, /Winner: Arrival \(2 votes\)/);
  const count = el("chatMessages").children.length;
  socket.receive(closed);
  socket.close();
  assert.equal(el("startPollButton").disabled, true);
  socket.receive(closed);
  assert.equal(el("chatMessages").children.length, count);
  socket.open();
  socket.receive({ ...open, poll: { id: "two", status: "open", result: null } });
  assert.equal(el("pollDetails").hidden, true, "An arriving poll is compact by default");
  assert.equal(el("votePanel").hidden, false);
});

for (const scenario of [
  { name: "tie", suggestions: [{ id: 1, title: "Arrival", votes: 1 }, { id: 2, title: "Moonlight", votes: 1 }], winnerIds: [1, 2], expected: /Tie: Arrival, Moonlight \(1 vote each\)/ },
  { name: "no votes", suggestions: [{ id: 1, title: "Arrival", votes: 0 }], winnerIds: [], expected: /No votes cast\./ }
]) {
  test(`joining a concluded poll posts its ${scenario.name} result once`, async () => {
    const b = createBrowserDouble();
    await b.load("js/app.js");
    const socket = b.sockets[0]; socket.open();
    const snapshot = { type: "party-state", suggestions: [], poll: { id: "closed", status: "closed", result: {
      suggestions: scenario.suggestions, winnerIds: scenario.winnerIds
    } } };
    socket.receive(snapshot);
    const messages = b.elements.get("chatMessages").children;
    assert.equal(messages.length, 1);
    assert.match(messages[0].textContent, scenario.expected);
    socket.receive(snapshot);
    assert.equal(messages.length, 1);
    assert.equal(b.elements.get("votePanel").hidden, true);
  });
}

test("ending a poll discards an in-flight search even when another poll starts", async () => {
  const b = createBrowserDouble();
  await b.load("js/app.js");
  const socket = b.sockets[0], el = id => b.elements.get(id);
  socket.open();
  const open = { type: "party-state", poll: { id: "one", status: "open" }, suggestions: [] };
  socket.receive(open);
  let resolve;
  b.context.fetch = () => new Promise(done => { resolve = done; });
  el("suggestionInput").value = "Arrival";
  el("suggestionForm").dispatch("submit");
  socket.receive({ ...open, poll: { id: "one", status: "closed" } });
  socket.receive({ ...open, poll: { id: "two", status: "open" } });
  resolve({ ok: true, json: async () => ({ movies: [{ title: "Old result" }] }) });
  await flush();
  assert.equal(el("suggestionResults").children.length, 0);
  assert.equal(el("suggestionStatus").textContent, "");
});

test("private-room suggestion removal survives browser session loss and explicit leave/rejoin", async t => {
  const app = createApplication({ config: { port: 0 }, encoderPromise: Promise.resolve(CPU_ENCODER) });
  const address = await app.listen(); t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  const api = async (path, body = {}, cookie = "") => {
    const response = await fetch(base + path, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.ok(response.ok);
    return { body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const browser = (await api("/api/viewer-identity")).cookie;
  const room = await api("/api/rooms", { name: "Poll ownership" });
  const join = () => api(`/rooms/${room.body.room.id}/api/join`, { accessCode: room.body.room.accessCode }, browser);
  const connect = async (membership, name, identity = browser) => {
    const peer = await connectPeer(base.replace("http", "ws") + room.body.endpoints.websocket, name, { headers: { Cookie: [identity, membership.cookie].filter(Boolean).join("; ") } });
    t.after(() => peer.ws.terminate()); return peer;
  };
  const host = await connect(room, "Host", "");
  host.send({ type: "start-video-poll" });
  const { poll: { id: pollId } } = await host.next("party-state", m => m.poll.status === "open");
  const membership = await join(), viewer = await connect(membership, "Owner");
  viewer.send({ type: "suggest-video", pollId, title: "Arrival" });
  await host.next("party-state", m => m.suggestions.length === 1);
  const closed = once(viewer.ws, "close"); viewer.ws.close(); await closed;
  const restartedMembership = await join();
  const returned = await connect(restartedMembership, "Owner returned");
  assert.notEqual(returned.role.clientId, viewer.role.clientId);
  const snapshot = await returned.next("party-state", m => m.suggestions.length === 1);
  assert.equal(snapshot.suggestions[0].canRemove, true);
  assert.equal(JSON.stringify(snapshot).includes("browser:"), false);
  await api(room.body.endpoints.leave, {}, `${browser}; ${restartedMembership.cookie}`);
  const rejoinedMembership = await join(), rejoined = await connect(rejoinedMembership, "Owner rejoined");
  assert.notEqual(rejoined.role.clientId, returned.role.clientId);
  const rejoinedState = await rejoined.next("party-state", m => m.suggestions.length === 1);
  assert.equal(rejoinedState.suggestions[0].canRemove, true);
  rejoined.send({ type: "remove-video-suggestion", pollId, suggestionId: snapshot.suggestions[0].id });
  await rejoined.next("party-state", m => m.poll.id === pollId && m.suggestions.length === 0);
  assert.equal(app.rooms.get(room.body.room.id).state.videoSuggestions.length, 0);
});
