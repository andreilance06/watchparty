const path = require("path");
const { serveFile } = require("./files");

function createHlsHandler({ state, config, media }) {
  async function serveHls(req, res, url) {
    if (!state.hlsDirectory || !state.mediaReady || Number(url.searchParams.get("v")) !== state.mediaVersion) {
      res.writeHead(404); res.end("Stream is not ready"); return;
    }
    const relative = url.pathname.slice("/hls/".length);
    const filePath = path.resolve(state.hlsDirectory, relative);
    if (!filePath.startsWith(`${path.resolve(state.hlsDirectory)}${path.sep}`)) { res.writeHead(403); res.end("Forbidden"); return; }
    const segmentMatch = /^segment_(\d{6})\.ts$/.exec(relative);
    if (!segmentMatch && !/^(?:master|video)\.m3u8$/.test(relative) && !/^captions_\d+\.ass$/.test(relative)) {
      res.writeHead(404); res.end("Not found"); return;
    }
    if (/^captions_\d+\.ass$/.test(relative) && !state.captionTracks.some((track) => track.url.split("?")[0].endsWith(`/${relative}`))) {
      res.writeHead(404); res.end("Not found"); return;
    }
    try {
      if (segmentMatch) {
        const index = Number(segmentMatch[1]);
        if (index >= Math.ceil(state.mediaDuration / config.segmentSeconds)) throw new Error("Invalid segment.");
        await media.ensureSegment(index);
      } else if (/^captions_\d+\.ass$/.test(relative)) {
        await media.waitForCaption(relative);
      }
      if (res.destroyed) return;
      if (Number(url.searchParams.get("v")) !== state.mediaVersion || !state.mediaReady) { res.writeHead(404); res.end("Stream replaced"); return; }
      serveFile(req, res, filePath);
    } catch (error) {
      if (!res.headersSent) { res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "1" }); res.end("The stream is temporarily unavailable. Check the host's file connection."); }
    }
  }

  return serveHls;
}

module.exports = { createHlsHandler };
