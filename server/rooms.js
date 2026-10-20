const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { createSession } = require("./state");
const { createTransport } = require("./transport");
const { createMediaService } = require("./media");
const { createHostSource } = require("./source-relay");
const { sanitizeDisplayName } = require("./names");
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
  const rooms = new Map(), codes = new Map();
  let closing = false;

  function scheduleExpiry(room) {
    clearTimeout(room.expiryTimer);
    if (room.id === "default" || room.state.clients.size) return;
    room.expiryTimer = setTimeout(() => destroy(room), config.roomIdleMs);
    room.expiryTimer.unref?.();
  }

  function build({ id = crypto.randomUUID(), name, accessCode = null, passwordHash = null, salt = null }) {
    if (closing) throw failure(503, "The server is shutting down.");
    const state = createSession();
    state.basePath = id === "default" ? "" : `/rooms/${id}`;
    const transport = createTransport(state.clients);
    const media = createMediaService({ state, config, encoderPromise, broadcast: transport.broadcast });
    const room = { id, name, accessCode, passwordHash, salt, state, transport, media, members: new Map() };
    room.source = createHostSource({ room, bridge, config });
    rooms.set(id, room);
    if (accessCode) codes.set(accessCode, room);
    scheduleExpiry(room);
    return room;
  }

  function destroy(room) {
    if (rooms.get(room.id) !== room) return;
    rooms.delete(room.id);
    if (room.accessCode) codes.delete(room.accessCode);
    clearTimeout(room.expiryTimer);
    room.state.shuttingDown = true;
    room.source.reset();
    room.media.reset();
    for (const client of room.state.clients.values()) client.ws.terminate();
    room.members.clear();
  }

  function membership(room, displayName) {
    if (room.members.size >= 1000) throw failure(429, "This room has too many memberships.");
    if (displayName != null && typeof displayName !== "string") throw failure(400, "Display name must be text.");
    const member = { id: crypto.randomUUID(), token: crypto.randomBytes(32).toString("base64url"), name: displayName ? sanitizeDisplayName(displayName) : null };
    room.members.set(member.token, member);
    return member;
  }

  function authenticate(req, room) {
    if (!room || room.id === "default") return null;
    const cookie = (req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith("watchparty-member="));
    return cookie ? room.members.get(cookie.slice("watchparty-member=".length)) || null : null;
  }

  function setCookie(req, res, room, member) {
    res.setHeader("Set-Cookie", `watchparty-member=${member?.token || ""}; Path=/rooms/${room.id}/; HttpOnly; SameSite=Strict${requestProtocol(req, config) === "https:" ? "; Secure" : ""}${member ? "" : "; Max-Age=0"}`);
  }

  function describe(room, member) {
    const prefix = room.state.basePath;
    return {
      room: { id: room.id, name: room.name, accessCode: room.accessCode, passwordRequired: Boolean(room.passwordHash),
        invitePath: `/?room=${encodeURIComponent(room.accessCode)}`, watchPath: `/?roomId=${room.id}` },
      member: { clientId: member.id, role: room.state.hostId === member.id ? "host" : "viewer" },
      endpoints: { session: `${prefix}/api/session`, leave: `${prefix}/api/leave`, websocket: `${prefix}/ws`, source: `${prefix}/source` }
    };
  }

  async function create(body) {
    if (body.displayName != null && typeof body.displayName !== "string") throw failure(400, "Display name must be text.");
    const name = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim() : "";
    if (!name || name.length > 80) throw failure(400, "Enter a room name of at most 80 characters.");
    if (body.password != null && (typeof body.password !== "string" || body.password.length > 128)) throw failure(400, "Password must be at most 128 characters.");
    let accessCode;
    if (body.accessCode != null && body.accessCode !== "") {
      if (typeof body.accessCode !== "string") throw failure(400, "Invalid access code.");
      accessCode = body.accessCode.trim().toUpperCase();
      if (!/^[A-Z0-9-]{4,32}$/.test(accessCode)) throw failure(400, "Access codes must be 4–32 letters, digits, or hyphens.");
    } else {
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      do { accessCode = Array.from({ length: 8 }, () => alphabet[crypto.randomInt(alphabet.length)]).join(""); } while (codes.has(accessCode));
    }
    if (codes.has(accessCode)) throw failure(409, "That access code is already in use.");
    const salt = body.password ? crypto.randomBytes(16) : null;
    const passwordHash = salt ? await scrypt(body.password, salt, 64) : null;
    // Hashing yields: check uniqueness again before committing the room.
    if (codes.has(accessCode)) throw failure(409, "That access code is already in use.");
    if (rooms.size >= 101) throw failure(429, "The server has reached its room limit.");
    const room = build({ name, accessCode, salt, passwordHash });
    const member = membership(room, body.displayName);
    room.state.hostId = member.id;
    return { room, member };
  }

  async function join(req, body, expectedRoom) {
    if (typeof body.accessCode !== "string") throw failure(400, "An access code is required.");
    const room = codes.get(body.accessCode.trim().toUpperCase());
    if (!room || (expectedRoom && room !== expectedRoom)) throw failure(404, "Room not found.");
    const existing = authenticate(req, room);
    if (existing) return { room, member: existing };
    if (room.passwordHash) {
      if (typeof body.password !== "string" || body.password.length > 128) throw failure(401, "Incorrect room password.");
      const candidate = await scrypt(body.password, room.salt, 64);
      if (!crypto.timingSafeEqual(candidate, room.passwordHash)) throw failure(401, "Incorrect room password.");
    }
    if (rooms.get(room.id) !== room) throw failure(404, "Room not found.");
    return { room, member: membership(room, body.displayName) };
  }

  const defaultRoom = build({ id: "default", name: "Default room" });
  return { rooms, defaultRoom, create, join, authenticate, setCookie, describe, scheduleExpiry,
    findByCode: (code) => typeof code === "string" ? codes.get(code.trim().toUpperCase()) : null,
    get: (id) => rooms.get(id), close: () => { closing = true; for (const room of [...rooms.values()]) destroy(room); } };
}

module.exports = { createRoomRegistry, validOrigin, requestProtocol, failure };
