const path = require("path");
const fs = require("node:fs");
const { currentTime } = require("../state");
const { serveFile } = require("./files");
const { segmentSchedule } = require("../media/playlists");

function createHlsHandler({ state: rootState, config, media: rootMedia }) {
  async function serveHls(req, res, url) {
    const renditionId = url.searchParams.get("r");
    const entry = renditionId ? rootMedia.rendition?.(renditionId) : null;
    if (renditionId && (!entry || entry.retired || Number(url.searchParams.get("g")) !== (rootState.streamGeneration || 0))) {
      res.writeHead(404); res.end("Rendition is no longer available"); return;
    }
    const state = entry?.state || rootState;
    const media = entry ? { ...rootMedia, ensureSegment: entry.service.ensure } : rootMedia;
    if (!state.hlsDirectory || !state.mediaReady || Number(url.searchParams.get("v")) !== state.mediaVersion) {
      res.writeHead(404); res.end("Stream is not ready"); return;
    }
    const relative = url.pathname.slice("/hls/".length);
    const generationKey = entry ? "rg" : "g";
    const generation = url.searchParams.has(generationKey) ? Number(url.searchParams.get(generationKey)) : state.streamGeneration || 0;
    if ((relative.endsWith(".m3u8") || relative.endsWith(".ts")) && generation !== (state.streamGeneration || 0)) {
      res.writeHead(404); res.end("Stream replaced"); return;
    }
    let filePath = path.resolve(state.hlsDirectory, relative);
    if (!filePath.startsWith(`${path.resolve(state.hlsDirectory)}${path.sep}`)) { res.writeHead(403); res.end("Forbidden"); return; }
    const segmentMatch = /^segment_(\d{6})\.ts$/.exec(relative);
    const font = /^font_\d+\.(?:ttf|otf)$/.test(relative) && media.fontFiles().includes(relative);
    if (entry && !segmentMatch && !/^(?:master|video)\.m3u8$/.test(relative)) { res.writeHead(404); res.end("Not found"); return; }
    if (!segmentMatch && !/^(?:master|video)\.m3u8$/.test(relative) && !/^captions_\d+\.ass$/.test(relative) && !font) {
      res.writeHead(404); res.end("Not found"); return;
    }
    if (/^captions_\d+\.ass$/.test(relative) && !state.captionTracks.some((track) => track.url.split("?")[0].endsWith(`/${relative}`))) {
      res.writeHead(404); res.end("Not found"); return;
    }
    try {
      if (segmentMatch) {
        if (entry) {
          entry.requests = (entry.requests || 0) + 1; entry.requestedAt = Date.now();
          res.once("close", () => { entry.requests--; });
        }
        const index = Number(segmentMatch[1]);
        if (index >= segmentSchedule(state, config.segmentSeconds).count) throw new Error("Invalid segment.");
        const controller = new AbortController();
        const abort = () => controller.abort();
        res.once("close", abort);
        const readyAt = performance.now();
        try { filePath = await media.ensureSegment(index, controller.signal, generation); }
        finally { res.removeListener("close", abort); }
        if (!res.destroyed) res.setHeader("Server-Timing", `media-wait;dur=${(performance.now() - readyAt).toFixed(1)}`);
      } else if (/^captions_\d+\.ass$/.test(relative)) {
        await media.waitForCaption(relative);
        const metrics = media.captionMetrics?.(relative);
        if (metrics && !res.destroyed) {
          res.setHeader("Server-Timing", `caption-index;dur=${(metrics.indexMs || 0).toFixed(1)}, caption-convert;dur=${(metrics.conversionMs || 0).toFixed(1)}`);
          res.setHeader("X-WatchParty-Caption-Metrics", JSON.stringify(metrics));
        }
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
      if (!res.headersSent) { res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "1" }); res.end(/^captions_\d+\.ass$/.test(relative) ? error.message : "The stream is temporarily unavailable. Check the host's file connection."); }
    }
  }

  return serveHls;
}

module.exports = { createHlsHandler };
