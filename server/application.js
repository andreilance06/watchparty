const http = require("http");
const { createConfig } = require("./config");
const { detectVideoEncoder } = require("./encoders");
const { resolveFfmpeg } = require("./ffmpeg");
const { resolveFfprobe, inspectFfprobe } = require("./ffprobe");
const { createRoomRegistry } = require("./rooms");
const { createSourceBridge } = require("./source-relay");
const { createRequestHandler } = require("./http/routes");
const { createRealtimeServer } = require("./realtime");
const { createMovieSearch } = require("./movies");

// Rooms share encoder detection and the internal byte bridge, never playback state.
function createApplication(options = {}) {
  const config = createConfig(options.config);
  const ffmpegReady = options.config?.ffmpegPath ? Promise.resolve() : resolveFfmpeg().then(selected => {
    config.ffmpegPath = selected.path;
    config.ffmpegCapabilities = selected;
    console.info(`FFmpeg: ${selected.path}\n${selected.version}; ${selected.reason}`);
  });
  const ffprobeReady = (options.config?.ffprobePath ? inspectFfprobe(config.ffprobePath) : resolveFfprobe()).then(selected => {
    config.ffprobePath = selected.path;
    console.info(`ffprobe: ${selected.path}\n${selected.version}; ${selected.reason || "explicit override"}`);
  });
  const initialization = Promise.all([ffmpegReady, ffprobeReady]);
  const encoderPromise = options.encoderPromise || ffmpegReady.then(() => detectVideoEncoder(config.ffmpegPath, config.ffmpegCapabilities));
  // listen() reports initialization failures; do not create an unhandled rejection meanwhile.
  initialization.catch(() => {});
  encoderPromise.catch(() => {});
  const bridge = createSourceBridge(config);
  const registry = createRoomRegistry({ config, encoderPromise, bridge });
  const { state, media } = registry.defaultRoom;
  const movieSearch = options.movieSearch || createMovieSearch(options.movieSearchOptions);
  const handler = createRequestHandler({ registry, config, movieSearch });
  const server = http.createServer(handler);
  const wss = createRealtimeServer(server, { registry, config, movieSearch });
  let closePromise;

  async function listen() {
    await initialization;
    await bridge.listen();
    try { return await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.removeListener("error", reject);
        resolve(server.address());
      });
    }); } catch (error) { await close(); throw error; }
  }

  function close() {
    if (closePromise) return closePromise;
    registry.close();
    closePromise = new Promise((resolve, reject) => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      if (!server.listening) { resolve(); return; }
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections?.();
    }).finally(() => bridge.close());
    return closePromise;
  }

  return { server, wss, state, config, media, rooms: registry.rooms, listen, close };
}

module.exports = { createApplication };
