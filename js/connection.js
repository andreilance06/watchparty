// Transport only: features decide which messages to send and how to apply them.
export function createConnection({ getIdentity, onMessage, onStatus }) {
  let socket;
  let reconnectTimer;
  let stopped = false;

  function send(payload) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }

  function connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${location.host}`);
    socket.addEventListener("open", () => {
      onStatus(true, "Connected");
      send({ type: "join", ...getIdentity() });
    });
    socket.addEventListener("message", (event) => onMessage(JSON.parse(event.data)));
    socket.addEventListener("close", () => {
      onStatus(false, "Disconnected");
      if (!stopped) reconnectTimer = setTimeout(connect, 1500);
    });
    socket.addEventListener("error", () => onStatus(false, "Connection error"));
  }

  function dispose() {
    stopped = true;
    clearTimeout(reconnectTimer);
    socket?.close();
  }

  return { connect, send, dispose };
}
