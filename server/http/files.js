const fs = require("fs");
const path = require("path");
const { MIME_TYPES } = require("../config");

function serveFile(req, res, filePath, options = {}) {
  fs.stat(filePath, (error, stat) => {
    if (res.destroyed) return;
    if (error || !stat.isFile()) {
      const status = error && error.code !== "ENOENT" ? 500 : 404;
      res.writeHead(status); res.end(status === 404 ? "Not found" : "Server error"); return;
    }
    const extension = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": options.cacheControl || (extension === ".m3u8" ? "no-store" : "private, max-age=3600, immutable")
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
  let requested;
  try {
    requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  } catch {
    res.writeHead(400); res.end("Invalid path"); return;
  }
  const filePath = path.resolve(publicDirectory, requested);
  if (!filePath.startsWith(`${publicDirectory}${path.sep}`) && filePath !== path.join(publicDirectory, "index.html")) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  serveFile(req, res, filePath, { cacheControl: /[.-][\w-]{8,}\.(?:js|css)$/.test(requested) && requested.startsWith("assets/")
    ? "public, max-age=31536000, immutable" : "no-store" });
}

module.exports = { serveFile, serveStatic };
