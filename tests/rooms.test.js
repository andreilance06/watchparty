const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const WebSocket = require("ws");
const { createApplication } = require("../server/application");
const { CPU_ENCODER } = require("../server/encoders");
const { connectPeer, serveHostFiles } = require("./helpers/peer");

async function setup(t, config = {}) {
  const app = createApplication({ config: { port: 0, hostReconnectGraceMs: 0, ...config }, encoderPromise: Promise.resolve(CPU_ENCODER) });
  const address = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  const api = async (path, body, cookie) => {
    const response = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0], headers: response.headers };
  };
  const connect = (session, name = "Guest") => connectPeer(base.replace("http", "ws") + session.body.endpoints.websocket, name, { headers: { Cookie: session.cookie } });
  return { app, base, api, connect };
}

test("public reconnects replace lingering sockets only for the verified browser", async t => {
  const { app, base, api } = await setup(t);
  const socketUrl = base.replace("http", "ws") + "/ws";
  const cookie = (await api("/api/viewer-identity")).cookie;
  const otherCookie = (await api("/api/viewer-identity")).cookie;
  const connect = async (name, browserCookie, resumeClientId) => {
    const url = new URL(socketUrl);
    if (resumeClientId) url.searchParams.set("resumeClientId", resumeClientId);
    const peer = await connectPeer(url.href, name, { headers: browserCookie ? { Cookie: browserCookie } : {} });
    t.after(() => peer.ws.terminate());
    return peer;
  };
  const original = await connect("lance", cookie);
  const oldClosed = once(original.ws, "close");
  // Leave the original server socket alive, as happens during a network interruption.
  const returned = await connect("lance", cookie, original.role.clientId);
  assert.equal((await oldClosed)[0], 4000);
  assert.equal(returned.role.clientId, original.role.clientId);
  assert.equal(returned.role.name, "lance");
  assert.equal(returned.role.nameRejected, undefined);
  assert.equal(returned.role.role, "host");
  assert.equal(app.state.clients.size, 1);
  assert.equal(app.state.clients.get(returned.role.clientId).name, "lance");

  const viewer = await connect("Viewer", otherCookie);
  const viewerClosed = once(viewer.ws, "close");
  const viewerReturned = await connect("Viewer", otherCookie, viewer.role.clientId);
  await viewerClosed;
  assert.equal(viewerReturned.role.clientId, viewer.role.clientId);
  assert.equal(viewerReturned.role.nameRejected, undefined);
  assert.equal(viewerReturned.role.role, "viewer");
  assert.equal(app.state.clients.size, 2);
  viewerReturned.send({ type: "chat", message: "Still here" });
  assert.equal((await returned.next("chat")).name, "Viewer");

  // A distinct tab can still connect without resuming another tab's socket.
  const tab = await connect("Other tab", cookie);
  assert.notEqual(tab.role.clientId, returned.role.clientId);
  assert.equal(returned.ws.readyState, WebSocket.OPEN);
  for (const attackerCookie of [otherCookie, "", cookie.replace(/.$/, "!")]) {
    const attacker = await connect("lance", attackerCookie, returned.role.clientId);
    assert.notEqual(attacker.role.clientId, returned.role.clientId);
    assert.equal(attacker.role.nameRejected, "lance");
    assert.equal(attacker.role.role, "viewer");
    assert.equal(returned.ws.readyState, WebSocket.OPEN);
  }
});

test("signed public resume restores a closed connection and host reservation", async t => {
  const { app, base, api } = await setup(t, { hostReconnectGraceMs: 15000 });
  const cookie = (await api("/api/viewer-identity")).cookie;
  const otherCookie = (await api("/api/viewer-identity")).cookie;
  const connect = async (name, browserCookie, resume) => {
    const url = new URL(base.replace("http", "ws") + "/ws");
    if (resume) {
      url.searchParams.set("resumeClientId", resume.clientId);
      url.searchParams.set("resumeToken", resume.resumeToken);
    }
    const peer = await connectPeer(url.href, name, { headers: { Cookie: browserCookie } });
    t.after(() => peer.ws.terminate());
    return peer;
  };
  const host = await connect("lance", cookie);
  const viewer = await connect("Viewer", otherCookie);
  assert.match(host.role.resumeToken, /^[\da-f]{64}$/);
  const closed = once(host.ws, "close");
  host.ws.close(); await closed;
  await viewer.next("party-state", m => m.host.status === "reconnecting");
  assert.equal(app.state.clients.has(host.role.clientId), false);

  const foreign = await connect("Other browser", otherCookie, host.role);
  assert.notEqual(foreign.role.clientId, host.role.clientId);
  assert.equal(foreign.role.role, "viewer");
  const returned = await connect("lance", cookie, host.role);
  assert.equal(returned.role.clientId, host.role.clientId);
  assert.equal(returned.role.name, "lance");
  assert.equal(returned.role.nameRejected, undefined);
  assert.equal(returned.role.role, "host");
  assert.equal(app.state.hostReconnectUntil, null);
  assert.equal([...app.state.clients.values()].filter(c => c.role === "host").length, 1);
  // A malformed token cannot restore an inactive viewer ID either.
  const foreignClosed = once(foreign.ws, "close");
  foreign.ws.close(); await foreignClosed;
  await returned.next("presence", m => !m.participants.some(p => p.clientId === foreign.role.clientId));
  const forged = await connect("Bad token", otherCookie, { ...foreign.role, resumeToken: '0'.repeat(64) });
  assert.notEqual(forged.role.clientId, foreign.role.clientId);
  returned.send({ type: "chat", message: "Reloaded" });
  assert.equal((await viewer.next("chat")).clientId, host.role.clientId);
});

function rejectedSocket(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.on("unexpected-response", (_, response) => { response.resume(); ws.terminate(); resolve(response.statusCode); });
    ws.on("open", () => { ws.terminate(); reject(new Error("An unauthorized WebSocket was accepted")); });
    ws.on("error", () => {});
  });
}

test("room admission uses IDs/passwords and preserves scoped membership", async (t) => {
  const { app, base, api, connect } = await setup(t);
  const created = await api("/api/rooms", { name: "  Friday   Films ", password: "my password", displayName: "Owner" });
  assert.equal(created.status, 201);
  assert.equal(created.body.room.name, "Friday Films");
  assert.equal("accessCode" in created.body.room, false);
  assert.equal(created.body.room.invitePath, `/?room=${created.body.room.id}`);
  assert.equal(created.body.room.watchPath, `/watch?roomId=${created.body.room.id}`);
  assert.equal(created.body.room.passwordRequired, true);
  assert.equal(created.body.member.role, "host");
  assert.match(created.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  assert.match(created.headers.get("set-cookie"), new RegExp(`Path=/rooms/${created.body.room.id}/`));
  assert.doesNotMatch(JSON.stringify(created.body), /my password|passwordHash/);
  assert.equal((await api("/api/rooms/join", { roomId: created.body.room.id, password: "wrong" })).status, 401);
  assert.equal((await api("/api/rooms/join", { roomId: created.body.room.id })).status, 401);
  assert.equal((await api("/api/rooms/join", { roomId: "missing-room" })).status, 404);
  const viewer = await api("/api/rooms/join", { roomId: created.body.room.id, password: "my password" });
  assert.equal(viewer.status, 200);
  assert.equal(viewer.body.member.role, "viewer");
  const reused = await api("/api/rooms/join", { roomId: created.body.room.id }, created.cookie);
  assert.equal(reused.body.member.clientId, created.body.member.clientId);
  assert.equal(reused.body.member.role, "host");
  const privatePath = created.body.endpoints.session;
  assert.equal((await fetch(base + privatePath)).status, 401);
  assert.equal((await fetch(base + privatePath, { headers: { Cookie: viewer.cookie } })).status, 200);
  const room = app.rooms.get(created.body.room.id);
  assert.equal(room.members.size, 2);
  assert.ok(Buffer.isBuffer(room.passwordHash));
  const creatorPeer = await connect(created, "Different browser name");
  assert.equal(creatorPeer.role.name, "Owner", "the initial room name is authoritative");
  creatorPeer.ws.close();
  const generated = await api("/api/rooms", { name: "Open room" });
  assert.equal(generated.body.room.passwordRequired, false);
  assert.equal((await api("/api/rooms/join", { roomId: generated.body.room.id })).status, 200);
  assert.equal((await api("/api/rooms/join", {})).status, 400);
  const guestSession = await api("/api/rooms", { name: "Guest naming", displayName: "Guest-AUTO" });
  const guestPeer = await connect(guestSession, "Old saved name");
  assert.equal(guestPeer.role.name, "Guest-AUTO");
  guestPeer.ws.close();
});

test("room endpoints reject bad inputs, cross-room credentials, and foreign origins", async (t) => {
  const { base, api } = await setup(t);
  const first = await api("/api/rooms", { name: "One" });
  const second = await api("/api/rooms", { name: "Two" });
  for (const body of [{}, { name: " " }, { name: "One", password: {} }, { name: "One", displayName: {} }]) {
    assert.equal((await api("/api/rooms", body)).status, 400);
  }
  assert.equal((await fetch(base + "/api/rooms", { method: "POST", body: "{" })).status, 400);
  assert.equal((await fetch(base + "/api/rooms", { method: "POST", body: "x".repeat(17000) })).status, 413);
  assert.equal((await fetch(base + "/api/rooms", { method: "POST", headers: { Origin: "https://foreign.example" }, body: "{}" })).status, 403);
  assert.equal((await fetch(base + second.body.endpoints.session, { headers: { Cookie: first.cookie } })).status, 401);
  assert.equal((await fetch(base + `/rooms/${second.body.room.id}/hls/master.m3u8?v=1`, { headers: { Cookie: first.cookie } })).status, 401);
  const socketUrl = base.replace("http", "ws") + second.body.endpoints.websocket;
  assert.equal(await rejectedSocket(socketUrl), 401);
  assert.equal(await rejectedSocket(socketUrl, { Cookie: first.cookie }), 401);
  assert.equal(await rejectedSocket(socketUrl, { Cookie: second.cookie, Origin: "https://foreign.example" }), 403);
  assert.equal((await fetch(base + "/server/rooms.js")).status, 404);
  assert.equal((await fetch(base + "/.git/config")).status, 404);
  assert.equal((await fetch(base + "/rooms/default/hls/master.m3u8?v=1")).status, 404);
  const races = await Promise.all([1, 2].map(() => api("/api/rooms", { name: "Racing", password: "secret" })));
  assert.deepEqual(races.map((result) => result.status), [201, 201]);
  assert.notEqual(races[0].body.room.id, races[1].body.room.id);
});

test("the root serves a separate hub, player bookmarks redirect, and the directory lists rooms without granting admission", async t => {
  const { app, base, api, connect } = await setup(t);
  const created = await api("/api/rooms", { name: "Friday films", password: "a private password" });
  const room = app.rooms.get(created.body.room.id);
  const directory = await fetch(base + "/api/rooms");
  assert.equal(directory.headers.get("cache-control"), "no-store");
  const { rooms } = await directory.json();
  assert.deepEqual(rooms.map(item => item.name), ["Default room", "Friday films"]);
  assert.equal(rooms[0].watchPath, "/watch");
  assert.equal(rooms[1].passwordRequired, true);
  assert.equal(rooms[1].participantCount, 0);
  assert.equal(rooms[1].thumbnailUrl, null);
  assert.doesNotMatch(JSON.stringify(rooms), /a private password|passwordHash|salt|token|127\.0\.0\.1/);
  assert.equal((await fetch(base + created.body.endpoints.session)).status, 401);
  const host = await connect(created);
  assert.equal((await (await fetch(base + "/api/rooms")).json()).rooms[1].participantCount, 1);
  assert.equal(room.state.clients.size, 1);
  const hub = await (await fetch(base)).text();
  assert.match(hub, /src="\/assets\/[^\"]+\.js"/);
  assert.doesNotMatch(hub, /movi-player|js\/app\.js|access code/i);
  const player = await (await fetch(base + created.body.room.watchPath)).text();
  assert.equal(player, hub, "hub and watch load the same React entry; the URL selects the page");
  assert.doesNotMatch(player, /id="roomEntry"|id="roomGrid"|access code/i);
  const old = await fetch(base + `/?roomId=${room.id}`, { redirect: "manual" });
  assert.equal(old.status, 302);
  assert.equal(old.headers.get("location"), created.body.room.watchPath);
  assert.equal((await fetch(base + "/api/rooms/default/thumbnail?v=1&r=1")).status, 404);
  assert.equal((await api(`/rooms/${room.id}/api/join`, { roomId: "another" })).status, 400);
  assert.equal((await api("/api/rooms/join", { roomId: "default" })).body.room.watchPath, "/watch");
  host.ws.close();
});

test("room creators retain hosting and all features stay inside their room", async (t) => {
  const { app, api, connect } = await setup(t);
  const one = await api("/api/rooms", { name: "One" });
  const two = await api("/api/rooms", { name: "Two" });
  const viewerSession = await api("/api/rooms/join", { roomId: one.body.room.id });
  const viewer = await connect(viewerSession, "Alex");
  assert.equal(viewer.role.role, "viewer", "A viewer arriving before the creator cannot become host");
  const host = await connect(one, "Host");
  const otherHost = await connect(two, "Alex");
  assert.equal(host.role.role, "host");
  assert.equal(otherHost.role.name, "Alex", "Names are unique per room, not globally");
  host.send({ type: "chat", message: "Private to room one" });
  const comment = await viewer.next("chat");
  assert.equal(comment.message, "Private to room one");
  viewer.send({ type: "chat", message: "A reply in room one", replyToId: comment.commentId, requestId: "room-reply" });
  const reply = await host.next("chat", message => message.requestId === "room-reply");
  assert.deepEqual(reply.replyTo, { commentId: comment.commentId, name: "Host", message: comment.message });
  otherHost.send({ type: "chat", message: "Foreign reply", replyToId: comment.commentId, requestId: "foreign" });
  const replyError = await otherHost.next("error", message => message.action === "chat");
  assert.equal(replyError.code, "REPLY_UNAVAILABLE");
  assert.equal(replyError.requestId, "foreign");
  otherHost.send({ type: "comment-reaction", commentId: comment.commentId, emoji: "❤️" });
  assert.match((await otherHost.next("error")).message, /comment reaction/);
  viewer.send({ type: "comment-reaction", commentId: comment.commentId, emoji: "❤️" });
  assert.deepEqual((await host.next("comment-reaction")).reactions, [
    { clientId: viewer.role.clientId, name: "Alex", emoji: "❤️" }
  ]);
  host.send({ type: "reaction", emoji: "👏" });
  await viewer.next("reaction");
  host.send({ type: "start-video-poll" });
  const { poll: { id: pollId } } = await host.next("party-state", message => message.poll.status === "open");
  host.send({ type: "suggest-video", pollId, title: "Only One" });
  await viewer.next("party-state", (message) => message.suggestions.length === 1);
  viewer.send({ type: "vote-video", pollId, suggestionId: 1 });
  await host.next("party-state", (message) => message.suggestions[0]?.votes === 1);
  otherHost.send({ type: "chat", message: "Room two marker" });
  await otherHost.next("chat");
  assert.equal(otherHost.messages.some((message) => message.type === "reaction" || message.type === "comment-reaction" || message.message === "Private to room one"), false);
  assert.equal(app.rooms.get(two.body.room.id).state.videoSuggestions.length, 0);
  assert.equal(app.rooms.get(two.body.room.id).state.videoVotes.size, 0);
  viewer.send({ type: "source-register", video: { id: "video", name: "movie.mkv", size: 100 } });
  assert.match((await viewer.next("error")).message, /permission/);
  host.ws.close();
  await viewer.next("host-left");
  assert.equal((await viewer.next("role")).role, "host");
  assert.equal(app.rooms.get(two.body.room.id).state.hostId, otherHost.role.clientId);
});

test("reconnect replacement, explicit leave, and empty-room expiry release memberships", async (t) => {
  const { app, base, api, connect } = await setup(t, { roomIdleMs: 150 });
  const created = await api("/api/rooms", { name: "Temporary" });
  const first = await connect(created, "Owner");
  const replaced = once(first.ws, "close");
  const replacement = await connect(created, "Owner");
  await replaced;
  assert.equal(replacement.role.clientId, first.role.clientId);
  const room = app.rooms.get(created.body.room.id);
  assert.equal(room.state.clients.size, 1);
  assert.equal(room.state.hostId, first.role.clientId);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(app.rooms.has(created.body.room.id));
  const closed = once(replacement.ws, "close");
  assert.equal((await api(created.body.endpoints.leave, {}, created.cookie)).status, 200);
  await closed;
  assert.equal((await fetch(base + created.body.endpoints.session, { headers: { Cookie: created.cookie } })).status, 401);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(app.rooms.has(created.body.room.id), false);
  assert.ok(app.rooms.has("default"));
  const abandoned = await api("/api/rooms", { name: "Never connected" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(app.rooms.has(abandoned.body.room.id), false);
});

test("two browser hosts stream and publish real thumbnails independently, including source replacement and disconnect", async (t) => {
  const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
  const { execFileSync } = require("node:child_process");
  const ffmpeg = require("ffmpeg-static");
  if (!ffmpeg || !fs.existsSync(ffmpeg)) { t.skip("FFmpeg is not installed"); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "watchparty-test-two-rooms-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const inputs = ["red", "blue"].map((color) => {
    const filename = path.join(directory, `${color}.mkv`);
    execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=160x90:r=15`, "-t", "12", "-c:v", "libx264", "-preset", "ultrafast", filename], { timeout: 20000, stdio: "pipe" });
    return { name: `${color}.mkv`, bytes: fs.readFileSync(filename) };
  });
  const { app, base, api, connect } = await setup(t);
  const sessions = await Promise.all(inputs.map((file) => api("/api/rooms", { name: file.name })));
  const hosts = await Promise.all(sessions.map((session) => connect(session, "Host")));
  const relays = await Promise.all(hosts.map((host, index) => serveHostFiles(host, base, inputs[index], [], { headers: { Cookie: sessions[index].cookie } })));
  const states = await Promise.all(hosts.map((host) => host.next("session-state", (message) => message.hasVideo)));
  const rooms = sessions.map((session) => app.rooms.get(session.body.room.id));
  await fetch(base + "/api/rooms"); // Starts asynchronous frame extraction through each browser's relay.
  for (let i = 0; i < 250 && rooms.some(room => !room.media.thumbnail()); i++) await new Promise(resolve => setTimeout(resolve, 20));
  const listedRooms = (await (await fetch(base + "/api/rooms")).json()).rooms;
  const thumbnailUrls = sessions.map(session => listedRooms.find(room => room.id === session.body.room.id).thumbnailUrl);
  for (const url of thumbnailUrls) {
    assert.ok(url, "a real thumbnail was extracted");
    const thumbnail = await fetch(base + url); // Hub images are public, even though original video bytes require admission.
    assert.equal(thumbnail.status, 200);
    assert.equal(thumbnail.headers.get("content-type"), "image/jpeg");
    const image = Buffer.from(await thumbnail.arrayBuffer());
    assert.deepEqual([...image.subarray(0, 2)], [255, 216]);
    assert.ok(image.length < 256 * 1024);
    assert.equal((await fetch(base + url, { method: "HEAD" })).status, 200);
    assert.equal((await fetch(base + url.replace(/r=\d+/, "r=999999"))).status, 404);
  }
  assert.notEqual(states[0].mediaUrl, states[1].mediaUrl);
  assert.notEqual(rooms[0].state.hlsDirectory, rooms[1].state.hlsDirectory);
  assert.equal(app.state.mediaPath, null);
  for (let index = 0; index < 2; index++) {
    assert.equal(states[index].fileName, inputs[index].name);
    assert.doesNotMatch(JSON.stringify(states[index]), /127\.0\.0\.1/);
    const headers = { Cookie: sessions[index].cookie };
    assert.equal((await fetch(base + states[index].originalUrl, { method: "HEAD", headers })).status, 200);
    assert.equal((await fetch(base + states[index].originalUrl, { headers: { Cookie: sessions[1 - index].cookie } })).status, 401);
    const master = await fetch(base + states[index].mediaUrl, { headers });
    assert.equal(master.status, 200);
    const segmentUrl = states[index].mediaUrl.replace("master.m3u8", "segment_000000.ts");
    const segment = await fetch(base + segmentUrl, { headers });
    assert.equal(segment.status, 200);
    assert.ok((await segment.arrayBuffer()).byteLength > 188);
    assert.equal((await fetch(base + segmentUrl, { headers: { Cookie: sessions[1 - index].cookie } })).status, 401);
    assert.ok(relays[index].reads.length > 0);
  }

  const savedDirectory = rooms[0].state.hlsDirectory;
  const replacement = await serveHostFiles(hosts[0], base, inputs[1], [], { headers: { Cookie: sessions[0].cookie } });
  const changed = await hosts[0].next("session-state", (message) => message.hasVideo && message.mediaUrl !== states[0].mediaUrl);
  assert.equal(changed.fileName, "blue.mkv");
  assert.equal((await fetch(base + thumbnailUrls[0])).status, 404, "old-source thumbnails are invalidated immediately");
  assert.equal((await fetch(base + thumbnailUrls[1])).status, 200);
  assert.ok(replacement.reads.length > 0);
  assert.equal((await fetch(base + states[0].mediaUrl, { headers: { Cookie: sessions[0].cookie } })).status, 404);
  const stillAvailable = await fetch(base + states[1].mediaUrl, { headers: { Cookie: sessions[1].cookie } });
  assert.equal(stillAvailable.status, 200);
  assert.equal(rooms[1].state.fileName, "blue.mkv");
  hosts[0].ws.close();
  await once(hosts[0].ws, "close");
  for (let i = 0; i < 30 && (rooms[0].state.mediaPath || fs.existsSync(savedDirectory)); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(rooms[0].state.mediaPath, null);
  assert.equal(rooms[0].media.thumbnail(), null);
  assert.equal(fs.existsSync(savedDirectory), false);
  assert.equal((await fetch(base + states[1].mediaUrl, { headers: { Cookie: sessions[1].cookie } })).status, 200);
});
