const http = require("http");
const { createConfig } = require("./config");
const { detectVideoEncoder } = require("./encoders");
const { createRoomRegistry } = require("./rooms");
const { createSourceBridge } = require("./source-relay");
const { createRequestHandler } = require("./http/routes");
const { createRealtimeServer } = require("./realtime");
const { createMovieSearch } = require("./movies");

// Rooms share encoder detection and the internal byte bridge, never playback state.
function createApplication(options = {}) {
  const config = createConfig(options.config);
  const encoderPromise = options.encoderPromise || detectVideoEncoder(config.ffmpegPath);
  const bridge = createSourceBridge(config);
  const registry = createRoomRegistry({ config, encoderPromise, bridge });
  const { state, media } = registry.defaultRoom;
  const movieSearch = options.movieSearch || createMovieSearch(options.movieSearchOptions);
  const handler = createRequestHandler({ registry, config, movieSearch });
  const server = http.createServer(handler);
  const wss = createRealtimeServer(server, { registry, config, movieSearch });
  let closePromise;

  async function listen() {
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
