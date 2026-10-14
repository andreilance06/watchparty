const WebSocket = require("ws");

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function createTransport(clients) {
  function broadcast(payload, exceptId = null) {
    for (const [id, client] of clients) {
      if (id !== exceptId) send(client.ws, payload);
    }
  }

  return { send, broadcast };
}

module.exports = { createTransport, send };
