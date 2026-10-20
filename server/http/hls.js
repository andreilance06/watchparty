const path = require("path");
const fs = require("node:fs");
const { currentTime } = require("../state");
const { serveFile } = require("./files");
const { segmentSchedule } = require("../media/playlists");

function createHlsHandler({ state, config, media }) {
  async function serveHls(req, res, url) {
    if (!state.hlsDirectory || !state.mediaReady || Number(url.searchParams.get("v")) !== state.mediaVersion) {
      res.writeHead(404); res.end("Stream is not ready"); return;
    }
    const relative = url.pathname.slice("/hls/".length);
    const generation = url.searchParams.has("g") ? Number(url.searchParams.get("g")) : state.streamGeneration || 0;
    if ((relative.endsWith(".m3u8") || relative.endsWith(".ts")) && generation !== (state.streamGeneration || 0)) {
      res.writeHead(404); res.end("Stream replaced"); return;
    }
    let filePath = path.resolve(state.hlsDirectory, relative);
    if (!filePath.startsWith(`${path.resolve(state.hlsDirectory)}${path.sep}`)) { res.writeHead(403); res.end("Forbidden"); return; }
    const segmentMatch = /^segment_(\d{6})\.ts$/.exec(relative);
    const font = /^font_\d+\.(?:ttf|otf)$/.test(relative) && media.fontFiles().includes(relative);
    if (!segmentMatch && !/^(?:master|video)\.m3u8$/.test(relative) && !/^captions_\d+\.ass$/.test(relative) && !font) {
      res.writeHead(404); res.end("Not found"); return;
    }
    if (/^captions_\d+\.ass$/.test(relative) && !state.captionTracks.some((track) => track.url.split("?")[0].endsWith(`/${relative}`))) {
      res.writeHead(404); res.end("Not found"); return;
    }
    try {
      if (segmentMatch) {
        const index = Number(segmentMatch[1]);
        if (index >= segmentSchedule(state, config.segmentSeconds).count) throw new Error("Invalid segment.");
        const controller = new AbortController();
        const abort = () => controller.abort();
        res.once("close", abort);
        try { filePath = await media.ensureSegment(index, controller.signal, generation); }
        finally { res.removeListener("close", abort); }
      } else if (/^captions_\d+\.ass$/.test(relative)) {
        await media.waitForCaption(relative);
      } else if (font) {
        await media.waitForFonts();
      }
      if (res.destroyed) return;
      if (Number(url.searchParams.get("v")) !== state.mediaVersion || !state.mediaReady ||
          (segmentMatch && generation !== (state.streamGeneration || 0))) { res.writeHead(404); res.end("Stream replaced"); return; }
      if (relative === "video.m3u8") {
        // Late joins and local decoder handoffs should request the shared
        // position immediately, rather than load the beginning and seek later.
        const start = Math.min(currentTime(state), Math.max(0, state.mediaDuration - 0.001));
        const body = fs.readFileSync(filePath, "utf8").replace("#EXT-X-PLAYLIST-TYPE:VOD",
          `#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-START:TIME-OFFSET=${start.toFixed(3)},PRECISE=YES`);
        res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body) });
        res.end(req.method === "HEAD" ? undefined : body); return;
      }
      serveFile(req, res, filePath);
    } catch (error) {
      if (!res.headersSent) { res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "1" }); res.end("The stream is temporarily unavailable. Check the host's file connection."); }
    }
  }

  return serveHls;
}

module.exports = { createHlsHandler };
