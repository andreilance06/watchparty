const { serveStatic } = require("./files");
const { createHlsHandler } = require("./hls");
const { validOrigin, failure } = require("../rooms");

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let length = 0, exceeded = false;
    const chunks = [];
    req.on("data", (chunk) => {
      length += chunk.length;
      if (length > 16384) {
        if (!exceeded) { exceeded = true; chunks.length = 0; reject(failure(413, "Request body is too large.")); }
      } else if (!exceeded) chunks.push(chunk);
    });
    req.once("error", reject);
    req.once("end", () => {
      if (exceeded) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch { reject(failure(400, "A JSON object is required.")); }
    });
  });
}

function createRequestHandler({ registry, config, movieSearch }) {
  const admissions = new Map();
  function admit(req) {
    const now = Date.now(), key = req.socket.remoteAddress;
    for (const [address, value] of admissions) if (value.until <= now) admissions.delete(address);
    const entry = admissions.get(key) || { until: now + 60000, count: 0 };
    if (entry.count++ >= 30) throw failure(429, "Too many room requests. Try again in a minute.");
    admissions.set(key, entry);
  }

  return async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "POST" && !validOrigin(req, config)) throw failure(403, "Request origin is not allowed.");
      if (url.pathname === "/api/movies/search") {
        if (req.method !== "GET") { res.setHeader("Allow", "GET"); throw failure(405, "Use GET for this endpoint."); }
        admit(req);
        if (!movieSearch) throw failure(503, "Movie search is unavailable.");
        const query = (url.searchParams.get("q") || "").replace(/\s+/g, " ").trim();
        if (query.length < 2) throw failure(400, "Enter at least two characters to search.");
        try {
          const movies = await movieSearch.search(query);
          json(res, 200, { movies });
        } catch (error) {
          throw failure(error.status || 502, error.message || "Movie search is temporarily unavailable.");
        }
        return;
      }
      if (url.pathname === "/api/rooms" || url.pathname === "/api/rooms/join") {
        if (req.method !== "POST") { res.setHeader("Allow", "POST"); throw failure(405, "Use POST for this endpoint."); }
        const body = await readJson(req);
        const creating = url.pathname === "/api/rooms";
        if (!creating) {
          if (typeof body.accessCode !== "string" || !body.accessCode.trim()) throw failure(400, "An access code is required.");
          const target = registry.findByCode(body.accessCode);
          if (!target) { admit(req); throw failure(404, "Room not found."); }
          // Redirect into the cookie's room scope before checking existing membership.
          res.writeHead(307, { Location: `/rooms/${target.id}/api/join`, "Cache-Control": "no-store" }); res.end(); return;
        }
        admit(req);
        const { room, member } = await registry.create(body);
        registry.setCookie(req, res, room, member);
        json(res, creating ? 201 : 200, registry.describe(room, member));
        return;
      }
      if (url.pathname === "/api/select-video") throw failure(410, "Choose the video in your browser using the host file relay.");
      const match = /^\/rooms\/([^/]+)(\/.*)?$/.exec(url.pathname);
      const room = match ? registry.get(match[1]) : registry.defaultRoom;
      if (match && (!room || room.id === "default")) throw failure(404, "Room not found.");
      if (match && match[2] === "/api/join") {
        if (req.method !== "POST") throw failure(405, "Use POST for this endpoint.");
        admit(req);
        const { member } = await registry.join(req, await readJson(req), room);
        registry.setCookie(req, res, room, member);
        json(res, 200, registry.describe(room, member)); return;
      }
      const member = match ? registry.authenticate(req, room) : null;
      if (match && !member) throw failure(401, "Join this room first.");
      const pathname = match ? match[2] || "/" : url.pathname;
      if (pathname === "/media/original" && ["GET", "HEAD"].includes(req.method)) {
        await room.source.serveOriginal(req, res, url); return;
      }
      if (match && pathname === "/api/session") {
        if (req.method !== "GET") throw failure(405, "Use GET for this endpoint.");
        json(res, 200, registry.describe(room, member)); return;
      }
      if (match && pathname === "/api/leave") {
        if (req.method !== "POST") throw failure(405, "Use POST for this endpoint.");
        room.members.delete(member.token);
        room.state.clients.get(member.id)?.ws.close(1000, "Left room");
        if (!room.state.clients.has(member.id) && room.state.hostId === member.id) {
          const next = room.state.clients.entries().next().value;
          room.state.hostId = next ? next[0] : null;
          if (next) {
            next[1].role = "host";
            room.transport.send(next[1].ws, { type: "role", role: "host", clientId: next[0], hostId: next[0], viewerCount: room.state.clients.size });
          }
        }
        registry.setCookie(req, res, room, null);
        registry.scheduleExpiry(room);
        json(res, 200, { left: true }); return;
      }
      if (pathname.startsWith("/hls/") && ["GET", "HEAD"].includes(req.method)) {
        const localUrl = new URL(url);
        localUrl.pathname = pathname;
        await createHlsHandler({ state: room.state, config, media: room.media })(req, res, localUrl);
        return;
      }
      if (match || url.pathname.startsWith("/api/")) throw failure(404, "Endpoint not found.");
      if (!["GET", "HEAD"].includes(req.method)) { res.setHeader("Allow", "GET, HEAD, POST"); throw failure(405, "Method not allowed."); }
      if (url.pathname !== "/" && !/^\/(?:index\.html|(?:js|css|vendor)\/)/.test(url.pathname)) throw failure(404, "Not found.");
      serveStatic(req, res, url, config.publicDirectory);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(res, error.status || 500, { error: error.status ? error.message : "Server error." });
      else if (!res.destroyed) res.destroy();
    }
  };
}

module.exports = { createRequestHandler, readJson };
