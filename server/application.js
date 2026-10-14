const http = require("http");
const { createConfig } = require("./config");
const { createSession } = require("./state");
const { createTransport } = require("./transport");
const { detectVideoEncoder } = require("./encoders");
const { createMediaService } = require("./media");
const { chooseVideoFile } = require("./file-picker");
const { createRequestHandler } = require("./http/routes");
const { createRealtimeServer } = require("./realtime");

// Composition root: creates one session and passes explicit dependencies to each service.
function createApplication(options = {}) {
  const config = createConfig(options.config);
  const state = createSession();
  const transport = createTransport(state.clients);
  const encoderPromise = options.encoderPromise || detectVideoEncoder(config.ffmpegPath);
  const media = createMediaService({ state, config, encoderPromise, broadcast: transport.broadcast });
  const handler = createRequestHandler({
    state, config, media, pickVideo: options.chooseVideoFile || chooseVideoFile
  });
  const server = http.createServer(handler);
  const wss = createRealtimeServer(server, { state, transport, media });
  let closePromise;

  function listen() {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, "0.0.0.0", () => {
        server.removeListener("error", reject);
        resolve(server.address());
      });
    });
  }

  function close() {
    if (closePromise) return closePromise;
    state.shuttingDown = true;
    media.reset();
    closePromise = new Promise((resolve, reject) => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      if (!server.listening) { resolve(); return; }
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections?.();
    });
    return closePromise;
  }

  return { server, wss, state, config, media, listen, close };
}

module.exports = { createApplication };
