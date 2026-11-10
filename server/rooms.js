const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { createSession } = require("./state");
const { createTransport } = require("./transport");
const { createMediaService } = require("./media");
const { createHostSource } = require("./source-relay");
const { sanitizeDisplayName } = require("./names");
const { createModeration } = require("./moderation");
const { createHosting } = require("./hosting");
const { createThumbnailQueue } = require("./media/thumbnails");
const scrypt = promisify(crypto.scrypt);

function failure(status, message) { return Object.assign(new Error(message), { status }); }

function requestProtocol(req, config = {}) {
  if (req.socket.encrypted) return "https:";
  const address = req.socket.remoteAddress;
  const trusted = config.trustProxy === "loopback" && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
  return trusted && req.headers["x-forwarded-proto"] === "https" ? "https:" : "http:";
}

function validOrigin(req, config = {}) {
  if (!req.headers.origin) return true;
  const expected = config.publicOrigin || `${requestProtocol(req, config)}//${req.headers.host}`;
  return req.headers.origin === expected;
}

function createRoomRegistry({ config, encoderPromise, bridge }) {
  const rooms = new Map();
  const thumbnails = createThumbnailQueue();
  const identitySecret = crypto.randomBytes(32);
  let closing = false;

  function browserIdentity(req, res) {
    const cookie = (req.headers.cookie || "").split(";").map(part => part.trim())
      .find(part => part.startsWith("watchparty-browser="))?.slice("watchparty-browser=".length);
    const sign = id => crypto.createHmac("sha256", identitySecret).update(id).digest("base64url");
    let id;
    if (cookie && /^[\da-f-]{36}\.[\w-]{43}$/.test(cookie)) {
      const [candidate, signature] = cookie.split(".");
      if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(sign(candidate)))) id = candidate;
    }
    if (res) {
      id ||= crypto.randomUUID();
      res.setHeader("Set-Cookie", `watchparty-browser=${id}.${sign(id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=34560000${requestProtocol(req, config) === "https:" ? "; Secure" : ""}`);
    }
    return id ? `browser:${id}` : null;
  }

  function scheduleExpiry(room) {
    clearTimeout(room.expiryTimer);
    if (room.id === "default" || room.state.clients.size || room.state.hostReconnectUntil) return;
    room.expiryTimer = setTimeout(() => destroy(room), config.roomIdleMs);
    room.expiryTimer.unref?.();
  }

  function build({ id = crypto.randomUUID(), name, passwordHash = null, salt = null }) {
    if (closing) throw failure(503, "The server is shutting down.");
    const state = createSession();
    state.basePath = id === "default" ? "" : `/rooms/${id}`;
    const transport = createTransport(state.clients);
    const media = createMediaService({ state, config, encoderPromise, broadcast: transport.broadcast, thumbnails });
    const room = { id, name, passwordHash, salt, state, transport, media, members: new Map(), activeResponses: new Map() };
    room.source = createHostSource({ room, bridge, config });
    room.hosting = createHosting(room, { config, scheduleExpiry });
    room.moderation = createModeration(room, scheduleExpiry);
    rooms.set(id, room);
    scheduleExpiry(room);
    return room;
  }

  function destroy(room) {
    if (rooms.get(room.id) !== room) return;
    rooms.delete(room.id);
    clearTimeout(room.expiryTimer);
    room.state.shuttingDown = true;
    room.hosting.cancel();
    room.source.reset();
    room.media.reset();
    for (const client of room.state.clients.values()) client.ws.terminate();
    room.members.clear();
    room.state.viewerPermissions.clear();
    room.state.viewerNames.clear();
    room.state.roomPermissions = {};
    room.state.blockedParticipants.clear();
    for (const responses of room.activeResponses.values()) for (const response of responses) response.destroy();
    room.activeResponses.clear();
  }

  function membership(room, displayName, identity = null) {
    if (room.members.size >= 1000) throw failure(429, "This room has too many memberships.");
    if (displayName != null && typeof displayName !== "string") throw failure(400, "Display name must be text.");
    const member = { id: crypto.randomUUID(), token: crypto.randomBytes(32).toString("base64url"), permissionIdentity: identity,
      name: displayName ? sanitizeDisplayName(displayName) : null };
    room.members.set(member.token, member);
    return member;
  }

  function cookieMember(req, room) {
    if (!room || room.id === "default") return null;
    const cookie = (req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith("watchparty-member="));
    return cookie ? room.members.get(cookie.slice("watchparty-member=".length)) || null : null;
  }

  function assertAdmission(req, room) {
    const member = cookieMember(req, room);
    if (room.state.blockedParticipants.has(browserIdentity(req)) ||
        member && room.state.blockedParticipants.has(member.permissionIdentity || `member:${member.id}`)) {
      throw Object.assign(failure(403, "You are blocked from this room until a host unblocks you."), { code: "ROOM_BLOCKED" });
    }
  }

  function authenticate(req, room) {
    const member = cookieMember(req, room);
    return member?.revoked ? null : member;
  }

  function trackResponse(req, res, room, member) {
    const key = member?.permissionIdentity || browserIdentity(req) || (member ? `member:${member.id}` : null);
    if (!key) return;
    let responses = room.activeResponses.get(key);
    if (!responses) room.activeResponses.set(key, responses = new Set());
    responses.add(res);
    res.once("close", () => { responses.delete(res); if (!responses.size && room.activeResponses.get(key) === responses) room.activeResponses.delete(key); });
  }

  function setCookie(req, res, room, member) {
    res.setHeader("Set-Cookie", `watchparty-member=${member?.token || ""}; Path=/rooms/${room.id}/; HttpOnly; SameSite=Strict${requestProtocol(req, config) === "https:" ? "; Secure" : ""}${member ? "" : "; Max-Age=0"}`);
  }

  function describe(room, member) {
    const prefix = room.state.basePath;
    return {
      room: { id: room.id, name: room.name, passwordRequired: Boolean(room.passwordHash),
        invitePath: `/?room=${encodeURIComponent(room.id)}`, watchPath: room.id === "default" ? "/watch" : `/watch?roomId=${room.id}` },
      member: member ? { clientId: member.id, role: room.state.hostId === member.id ? "host" : "viewer" } : null,
      endpoints: { session: `${prefix}/api/session`, leave: `${prefix}/api/leave`, websocket: `${prefix}/ws`, source: `${prefix}/source` }
    };
  }

  async function create(body, identity = null) {
    if (body.displayName != null && typeof body.displayName !== "string") throw failure(400, "Display name must be text.");
    const name = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim() : "";
    if (!name || name.length > 80) throw failure(400, "Enter a room name of at most 80 characters.");
    if (body.password != null && (typeof body.password !== "string" || body.password.length > 128)) throw failure(400, "Password must be at most 128 characters.");
    const salt = body.password ? crypto.randomBytes(16) : null;
    const passwordHash = salt ? await scrypt(body.password, salt, 64) : null;
    if (rooms.size >= 101) throw failure(429, "The server has reached its room limit.");
    const room = build({ name, salt, passwordHash });
    const member = membership(room, body.displayName, identity);
    room.state.hostId = member.id;
    room.state.creatorMemberId = member.id;
    room.state.creatorIdentity = identity || `member:${member.id}`;
    return { room, member };
  }

  async function join(req, body, expectedRoom) {
    const room = expectedRoom || (typeof body.roomId === "string" ? rooms.get(body.roomId) : null);
    if (expectedRoom && body.roomId != null && body.roomId !== expectedRoom.id) throw failure(400, "Room ID does not match this room.");
    if (!room) throw failure(404, "Room not found.");
    assertAdmission(req, room);
    const existing = authenticate(req, room);
    if (existing) return { room, member: existing };
    if (room.passwordHash) {
      if (typeof body.password !== "string" || body.password.length > 128) throw failure(401, "Incorrect room password.");
      const candidate = await scrypt(body.password, room.salt, 64);
      if (!crypto.timingSafeEqual(candidate, room.passwordHash)) throw failure(401, "Incorrect room password.");
    }
    if (rooms.get(room.id) !== room) throw failure(404, "Room not found.");
    assertAdmission(req, room);
    return { room, member: membership(room, body.displayName, browserIdentity(req)) };
  }

  const defaultRoom = build({ id: "default", name: "Default room" });
  return { rooms, defaultRoom, create, join, authenticate, setCookie, describe, scheduleExpiry, browserIdentity, assertAdmission, trackResponse,
    list: () => [...rooms.values()].map(room => {
      room.media.refreshThumbnail();
      const thumbnail = room.media.thumbnail();
      return { ...describe(room).room, participantCount: room.state.clients.size,
        fileName: room.state.fileName, thumbnailUrl: thumbnail ? `/api/rooms/${room.id}/thumbnail?v=${thumbnail.version}&r=${thumbnail.revision}` : null };
    }),
    get: (id) => rooms.get(id), close: () => { closing = true; for (const room of [...rooms.values()]) destroy(room); } };
}

module.exports = { createRoomRegistry, validOrigin, requestProtocol, failure };
