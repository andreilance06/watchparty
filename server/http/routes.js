const fs = require("fs");
const { serveStatic } = require("./files");
const { createHlsHandler } = require("./hls");

function createRequestHandler({ state, config, media, pickVideo }) {
  const serveHls = createHlsHandler({ state, config, media });

  function selectVideo(req, res) {
    let body = "";
    req.on("data", (chunk) => { if (body.length < 10000) body += chunk; });
    req.on("end", () => {
      let requesterId = "";
      try { requesterId = JSON.parse(body).clientId; } catch {}
      if (!requesterId || requesterId !== state.hostId) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Only the host can choose a video." }));
        return;
      }
      pickVideo((error, stdout) => {
        const selectedPath = String(stdout || "").trim();
        if (error || !selectedPath) {
          const unavailable = error && error.code === 127;
          res.writeHead(unavailable ? 500 : 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(unavailable ? { error: "Install Zenity or KDialog to use the file picker." } : { cancelled: true }));
          return;
        }
        fs.stat(selectedPath, (statError, stat) => {
          if (statError || !stat.isFile()) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "The selected video could not be opened." }));
            return;
          }
          const snapshot = media.select(selectedPath);
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify(snapshot));
          media.prepare(selectedPath);
        });
      });
    });
  }

  return (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/hls/") && (req.method === "GET" || req.method === "HEAD")) {
      serveHls(req, res, url);
      return;
    }
    if (url.pathname === "/api/select-video" && req.method === "POST") {
      selectVideo(req, res);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD, POST" }); res.end(); return;
    }
    serveStatic(req, res, url, config.publicDirectory);
  };
}

module.exports = { createRequestHandler };
