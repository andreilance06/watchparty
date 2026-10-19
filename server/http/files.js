const fs = require("fs");
const path = require("path");
const { MIME_TYPES } = require("../config");

function serveFile(req, res, filePath) {
  fs.stat(filePath, (error, stat) => {
    if (res.destroyed) return;
    if (error || !stat.isFile()) { res.writeHead(404); res.end("Not found"); return; }
    const extension = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": extension === ".m3u8" ? "no-store" : "private, max-age=3600, immutable"
    });
    if (req.method === "HEAD") res.end();
    else {
      const stream = fs.createReadStream(filePath);
      stream.once("error", () => res.destroy());
      res.once("close", () => stream.destroy());
      stream.pipe(res);
    }
  });
}

function serveStatic(req, res, url, publicDirectory) {
  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const filePath = path.resolve(publicDirectory, requested);
  if (!filePath.startsWith(`${publicDirectory}${path.sep}`) && filePath !== path.join(publicDirectory, "index.html")) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(error.code === "ENOENT" ? 404 : 500);
      res.end(error.code === "ENOENT" ? "Not found" : "Server error");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    if (req.method === "HEAD") res.end(); else res.end(data);
  });
}

module.exports = { serveFile, serveStatic };
