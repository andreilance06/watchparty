const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const WebSocket = require("ws");
const { createApplication } = require("../server/application");
const { CPU_ENCODER } = require("../server/encoders");
const { DEFAULT_PERMISSIONS } = require("../server/permissions");
const { connectPeer, serveHostFiles } = require("./helpers/peer");
const { createBrowserDouble } = require("./helpers/browser");
const flush = () => new Promise(resolve => setImmediate(resolve));

async function setup(t, config = {}) {
  const app = createApplication({ config: { port: 0, ...config }, encoderPromise: Promise.resolve(CPU_ENCODER) });
  const address = await app.listen(); t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  const api = async (url, body = {}, cookie = "") => {
    const response = await fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const connect = async (name, cookie = "", endpoint = "/") => {
    const peer = await connectPeer(base.replace("http", "ws") + endpoint, name, { headers: { Cookie: cookie } });
    t.after(() => peer.ws.terminate()); return peer;
  };
  const action = async (peer, type, clientId, fail = false) => {
    const requestId = randomUUID(); peer.send({ type, clientId, requestId });
    return peer.next(fail ? "error" : "participant-action-complete", message => message.requestId === requestId);
  };
  const close = async peer => { const done = once(peer.ws, "close"); peer.ws.close(); await done; };
  return { app, base, api, connect, action, close };
}

function rejectedSocket(url, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Cookie: cookie } });
    ws.on("unexpected-response", (_, response) => { response.resume(); ws.terminate(); resolve(response.statusCode); });
    ws.on("open", () => { ws.terminate(); reject(new Error("Blocked socket was admitted")); });
    ws.on("error", () => {});
  });
}

test("blocking closes all browser tabs, retains a disabled roster entry, and survives host transfer", async t => {
  const f = await setup(t);
  const host = await f.connect("Host"), successor = await f.connect("Successor");
  const identity = (await f.api("/api/viewer-identity")).cookie;
  const viewer = await f.connect("Alex", identity), otherTab = await f.connect("Alex second tab", identity);
  const closed = [once(viewer.ws, "close"), once(otherTab.ws, "close")];
  await f.action(host, "block-participant", viewer.role.clientId);
  assert.equal((await viewer.next("room-blocked")).type, "room-blocked");
  assert.equal((await Promise.all(closed))[0][0], 4003);
  const snapshot = await host.next("presence", m => m.participants.some(p => p.blocked));
  assert.equal(snapshot.count, 2);
  assert.deepEqual(snapshot.participants.filter(p => p.blocked).map(p => [p.name, p.connected]), [["Alex", false]]);
  assert.doesNotMatch(JSON.stringify(snapshot), /browser:|watchparty-browser/);
  for (const endpoint of ["/api/session", "/media/original?v=1", "/hls/master.m3u8?v=1"]) {
    assert.equal((await fetch(f.base + endpoint, { headers: { Cookie: identity } })).status, 403);
  }
  assert.equal(await rejectedSocket(f.base.replace("http", "ws") + "/ws", identity), 403);
  assert.equal(await rejectedSocket(f.base.replace("http", "ws") + "/source", identity), 403);
  await f.action(host, "transfer-host", successor.role.clientId);
  const inherited = await successor.next("party-state", m => m.participants.some(p => p.blocked));
  assert.equal(inherited.participants.find(p => p.blocked).name, "Alex");
  await f.action(successor, "unblock-participant", viewer.role.clientId);
  assert.equal((await fetch(f.base + "/api/session", { headers: { Cookie: identity } })).status, 200);
  const returned = await f.connect("Renamed", identity);
  assert.deepEqual(returned.role.permissions, DEFAULT_PERMISSIONS);
  assert.equal(f.app.state.blockedParticipants.size, 0);
});

test("private-room blocks reject old memberships and new admission until unblocked, and expire with the room", async t => {
  const f = await setup(t, { roomIdleMs: 100 });
  const created = await f.api("/api/rooms", { name: "Private moderation", password: "secret" });
  const host = await f.connect("Host", created.cookie, created.body.endpoints.websocket);
  const identity = (await f.api("/api/viewer-identity")).cookie;
  const body = { accessCode: created.body.room.accessCode, password: "secret" };
  let membership = await f.api("/api/rooms/join", body, identity);
  const cookie = `${membership.cookie}; ${identity}`;
  const viewer = await f.connect("Viewer", cookie, membership.body.endpoints.websocket);
  host.send({ type: "set-viewer-permissions", clientId: viewer.role.clientId, permissions: { playPause: false, seek: true, playbackRate: false } });
  await viewer.next("permissions-updated");
  await f.action(host, "block-participant", viewer.role.clientId);
  assert.equal((await f.api("/api/rooms/join", body, identity)).status, 403);
  assert.equal((await fetch(f.base + membership.body.endpoints.session, { headers: { Cookie: cookie } })).status, 403);
  const elsewhere = await f.connect("Elsewhere", identity);
  assert.equal(elsewhere.role.role, "host");
  await f.action(host, "unblock-participant", viewer.role.clientId);
  assert.equal((await fetch(f.base + membership.body.endpoints.session, { headers: { Cookie: cookie } })).status, 401);
  membership = await f.api("/api/rooms/join", body, identity);
  const rejoined = await f.connect("Back", `${membership.cookie}; ${identity}`, membership.body.endpoints.websocket);
  assert.deepEqual(rejoined.role.permissions, { playPause: false, seek: true, playbackRate: false });
  await f.action(host, "block-participant", rejoined.role.clientId);
  const room = f.app.rooms.get(created.body.room.id);
  await f.close(host); await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(f.app.rooms.has(room.id), false); assert.equal(room.state.blockedParticipants.size, 0);
});

test("moderation rejects unauthorized, self, cross-room, and concurrent stale-host actions", async t => {
  const f = await setup(t);
  const host = await f.connect("Host"), one = await f.connect("One"), two = await f.connect("Two");
  for (const type of ["block-participant", "unblock-participant", "transfer-host"]) {
    assert.match((await f.action(one, type, two.role.clientId, true)).message, /current host/);
  }
  assert.match((await f.action(host, "block-participant", host.role.clientId, true)).message, /connected viewer/);
  assert.match((await f.action(host, "transfer-host", randomUUID(), true)).message, /connected viewer/);
  const first = randomUUID(), second = randomUUID();
  host.send({ type: "transfer-host", clientId: one.role.clientId, requestId: first });
  host.send({ type: "transfer-host", clientId: two.role.clientId, requestId: second });
  await host.next("participant-action-complete", m => m.requestId === first);
  assert.match((await host.next("error", m => m.requestId === second)).message, /current host/);
  assert.equal([...f.app.state.clients.values()].filter(client => client.role === "host").length, 1);
  assert.equal(f.app.state.hostId, one.role.clientId);
});

function movie(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "watchparty-moderation-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "transfer.mp4");
  execFileSync(require("ffmpeg-static"), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24", "-t", "60", "-c:v", "libx264", "-preset", "ultrafast", "-movflags", "+faststart", filename]);
  return { name: "transfer.mp4", bytes: fs.readFileSync(filename) };
}

async function addCaptions(peer, f, sourceId, cookie = "") {
  const fileId = randomUUID(), bytes = Buffer.from("1\n00:00:00,000 --> 00:00:02,000\nNew host caption\n");
  const metadata = { id: fileId, name: "new.srt", size: bytes.length }, requestId = randomUUID();
  peer.send({ type: "caption-provider-register", sourceId, requestId, files: [metadata] });
  const registration = await peer.next("caption-provider-registered", m => m.requestId === requestId);
  const ws = new WebSocket(f.base.replace("http", "ws") + registration.relayPath, { headers: { Cookie: cookie } });
  const attached = new Promise((resolve, reject) => {
    ws.on("error", reject);
    ws.on("message", raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === "source-attached") resolve();
      if (message.type === "source-read") {
        assert.equal(message.fileId, fileId);
        const frame = Buffer.alloc(4 + message.length); frame.writeUInt32BE(message.requestId);
        bytes.copy(frame, 4, message.offset, message.offset + message.length); ws.send(frame);
      }
    });
  });
  await once(ws, "open"); ws.send(JSON.stringify({ type: "source-attach", sourceId, providerId: registration.providerId, token: registration.token }));
  await attached;
  peer.send({ type: "captions-add", sourceId, providerId: registration.providerId, files: [metadata], requestId });
  await peer.next("captions-managed", m => m.requestId === requestId);
  ws.close(); return fileId;
}

test("host transfer preserves video bytes, clock, captions and HLS generation; the new host can manage captions", async t => {
  const f = await setup(t, { sourceCacheBytes: 1 });
  const host = await f.connect("Original"), next = await f.connect("Next");
  const video = movie(t);
  const initialCaption = { name: "initial.srt", bytes: Buffer.from("1\n00:00:00,000 --> 00:00:02,000\nInitial\n") };
  const relay = await serveHostFiles(host, f.base, video, [initialCaption]);
  t.after(() => relay.ws.terminate());
  const ready = await host.next("session-state", m => m.hasVideo);
  host.send({ type: "video-state", syncMode: "seek", time: 15, paused: true, playbackRate: 1.5 });
  const sought = await host.next("session-state", m => m.syncMode === "seek");
  await f.action(host, "transfer-host", next.role.clientId);
  const transfer = await next.next("session-state", m => m.syncMode === "host-transfer");
  assert.equal(transfer.mediaVersion, ready.mediaVersion); assert.equal(transfer.streamGeneration, sought.streamGeneration);
  assert.equal(transfer.time, 15); assert.equal(transfer.paused, true); assert.equal(transfer.playbackRate, 1.5);
  assert.equal(transfer.sourceOwnerId, host.role.clientId); assert.equal(transfer.sourceId, relay.sourceId);
  assert.equal(relay.ws.readyState, 1); assert.deepEqual(transfer.captions, ready.captions);
  const beforeReads = relay.reads.length, offset = Math.floor(video.bytes.length / 2);
  const bytes = await fetch(f.base + transfer.originalUrl, { headers: { Range: `bytes=${offset}-${offset + 31}` } });
  assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), video.bytes.subarray(offset, offset + 32));
  assert.ok(relay.reads.length > beforeReads, "The demoted host still supplies uncached bytes");
  const segment = await fetch(f.base + transfer.compatibilityUrl.replace("master.m3u8", "segment_000007.ts"));
  assert.equal(segment.status, 200); assert.ok((await segment.arrayBuffer()).byteLength > 188);
  host.send({ type: "video-state", syncMode: "tick", time: 0, paused: false, playbackRate: 4 });
  await host.next("playback-rejected"); assert.equal(f.app.state.playback.time, 15);
  const fileId = await addCaptions(next, f, relay.sourceId);
  const added = f.app.state.captionTracks.find(track => track.fileId === fileId); assert.ok(added);
  assert.match(await (await fetch(f.base + added.url)).text(), /New host caption/);
  next.send({ type: "caption-provider-register", sourceId: relay.sourceId, requestId: "abandoned-caption",
    files: [{ id: "abandoned", name: "abandoned.srt", size: 10 }] });
  const temporary = await next.next("caption-provider-registered", m => m.requestId === "abandoned-caption");
  const captionSocket = new WebSocket(f.base.replace("http", "ws") + temporary.relayPath);
  await once(captionSocket, "open");
  const attached = once(captionSocket, "message");
  captionSocket.send(JSON.stringify({ type: "source-attach", sourceId: relay.sourceId, providerId: temporary.providerId, token: temporary.token }));
  await attached;
  const lostCaption = once(captionSocket, "close"); captionSocket.close(); await lostCaption;
  assert.equal(f.app.state.mediaVersion, ready.mediaVersion); assert.equal(relay.ws.readyState, 1);
  next.send({ type: "caption-remove", sourceId: relay.sourceId, trackId: ready.captions[0].id, requestId: "remove-initial" });
  await next.next("captions-managed", m => m.requestId === "remove-initial");
  assert.equal((await host.next("source-release-file")).sourceId, relay.sourceId);
  assert.equal(f.app.state.mediaVersion, ready.mediaVersion); assert.equal(f.app.state.playback.time, 15);
  next.send({ type: "video-state", syncMode: "play", time: 15, paused: false, playbackRate: 1.5 });
  await host.next("session-state", m => m.syncMode === "play");
  const generation = f.app.state.streamGeneration;
  await f.close(next);
  await host.next("role", m => m.role === "host");
  assert.equal(f.app.state.mediaVersion, ready.mediaVersion); assert.equal(relay.ws.readyState, 1);
  assert.equal(f.app.state.playback.paused, false); assert.equal(f.app.state.streamGeneration, generation);
});

test("blocking the video provider ends that source and the remaining host can replace it", async t => {
  const f = await setup(t); const original = await f.connect("Provider"), host = await f.connect("Controller");
  const video = movie(t), relay = await serveHostFiles(original, f.base, video);
  t.after(() => relay.ws.terminate());
  const ready = await host.next("session-state", m => m.hasVideo);
  await f.action(original, "transfer-host", host.role.clientId);
  await f.action(host, "block-participant", original.role.clientId);
  assert.equal(f.app.state.mediaPath, null); assert.equal(f.app.state.hostId, host.role.clientId);
  assert.equal((await fetch(f.base + ready.originalUrl)).status, 404);
  const replacement = await serveHostFiles(host, f.base, video); t.after(() => replacement.ws.terminate());
  const replaced = await host.next("session-state", m => m.hasVideo && m.mediaVersion > ready.mediaVersion);
  assert.equal(replaced.sourceOwnerId, host.role.clientId);
});

test("blocking a viewer cancels their in-flight media response without ending the video", async t => {
  const f = await setup(t, { sourceCacheBytes: 1 });
  const host = await f.connect("Host"), identity = (await f.api("/api/viewer-identity")).cookie;
  const viewer = await f.connect("Viewer", identity), video = movie(t);
  const relay = await serveHostFiles(host, f.base, video); t.after(() => relay.ws.terminate());
  const ready = await host.next("session-state", m => m.hasVideo);
  await (await fetch(f.base + ready.originalUrl, { headers: { Range: "bytes=0-31" } })).arrayBuffer();
  relay.ws.removeAllListeners("message");
  const offset = Math.floor(video.bytes.length / 2), read = once(relay.ws, "message");
  const pending = fetch(f.base + ready.originalUrl, { headers: { Cookie: identity, Range: `bytes=${offset}-${offset + 31}` } }).then(response => response.arrayBuffer());
  const cancelled = assert.rejects(pending);
  await read;
  assert.equal(f.app.rooms.get("default").activeResponses.size, 1);
  await f.action(host, "block-participant", viewer.role.clientId); await cancelled;
  assert.equal(f.app.state.mediaVersion, ready.mediaVersion); assert.equal(f.app.state.mediaReady, true);
  assert.equal(relay.ws.readyState, 1);
});

test("participant dropdown shows read-only permissions, blocked styling, actions, and outside dismissal", async () => {
  const b = createBrowserDouble(); await b.load("js/app.js"); const socket = b.sockets[0]; socket.open();
  const el = id => b.elements.get(id);
  socket.receive({ type: "role", role: "viewer", clientId: "self" });
  const people = [{ clientId: "other", name: "Alex", role: "viewer", permissions: DEFAULT_PERMISSIONS }];
  socket.receive({ type: "presence", count: 2, participants: people });
  const trigger = el("participantList").children[0].children[0]; trigger.click();
  const inputs = () => el("participantDetails").children.filter(child => child.className === "permission-switch").map(label => label.children[1]);
  assert.ok(inputs().every(input => input.disabled));
  assert.equal(el("participantDetails").children.some(child => child.className === "participant-actions"), false);
  b.document.dispatch("pointerdown", { composedPath: () => [el("chatInput")] }); assert.equal(el("participantDropdown").hidden, true);
  trigger.click(); socket.receive({ type: "role", role: "host", clientId: "self" });
  assert.ok(inputs().every(input => !input.disabled));
  let actions = el("participantDetails").children.at(-1);
  assert.deepEqual(actions.children.map(button => button.textContent), ["Transfer host", "Kick and block"]);
  actions.children[1].click(); const command = socket.sent.at(-1); assert.equal(command.type, "block-participant");
  socket.receive({ type: "presence", count: 1, participants: [{ ...people[0], connected: false, blocked: true }] });
  assert.equal(trigger.classList.contains("participant-blocked"), true);
  assert.equal(el("viewerCount").textContent, "1 online"); assert.ok(inputs().every(input => input.disabled));
  socket.receive({ type: "participant-action-complete", requestId: command.requestId });
  actions = el("participantDetails").children.at(-1); assert.equal(actions.children[0].textContent, "Unblock");
  actions.children[0].click(); assert.equal(socket.sent.at(-1).type, "unblock-participant");
});

test("blocked browsers stop reconnecting and return to room selection", async () => {
  const b = createBrowserDouble(); await b.load("js/app.js"); const socket = b.sockets[0]; socket.open();
  socket.receive({ type: "role", role: "viewer", clientId: "viewer" });
  socket.receive({ type: "room-blocked" }); b.runTimers(1500); await flush();
  assert.equal(b.sockets.length, 1); assert.equal(b.elements.get("roomEntry").hidden, false);
  assert.match(b.elements.get("roomEntryStatus").textContent, /blocked/);
  const fresh = createBrowserDouble();
  fresh.context.fetch = async url => url === "/api/session" ? { ok: false, json: async () => ({ code: "ROOM_BLOCKED" }) } : { ok: true };
  await fresh.load("js/app.js"); assert.equal(fresh.sockets.length, 0);
  assert.match(fresh.elements.get("roomEntryStatus").textContent, /blocked/);
});
