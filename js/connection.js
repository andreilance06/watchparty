// Transport only: features decide which messages to send and how to apply them.
export function createConnection({ getIdentity, onMessage, onStatus, onBlocked = () => {}, beforeReconnect, path = "/" }) {
  let socket;
  let reconnectTimer;
  let stopped = false;

  function send(payload) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }

  function connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${location.host}${path}`);
    socket.addEventListener("open", () => {
      onStatus(true, "Connected");
      send({ type: "join", ...getIdentity() });
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "room-blocked") { stopped = true; clearTimeout(reconnectTimer); }
      onMessage(message);
    });
    socket.addEventListener("close", (event) => {
      if (event.code === 4000) stopped = true;
      if (event.code === 4003) stopped = true;
      onStatus(false, event.code === 4000 ? "Connected in another tab" : "Disconnected");
      if (event.code === 4003) onBlocked();
      if (!stopped) reconnectTimer = setTimeout(reconnect, 1500);
    });
    socket.addEventListener("error", () => onStatus(false, "Connection error"));
  }

  async function reconnect() {
    if (stopped) return;
    try {
      if (beforeReconnect && await beforeReconnect() === false) return;
      if (!stopped) connect();
    } catch (error) {
      onStatus(false, error.message);
      if (!stopped) reconnectTimer = setTimeout(reconnect, 1500);
    }
  }

  function dispose() {
    stopped = true;
    clearTimeout(reconnectTimer);
    socket?.close();
  }

  return { connect, send, dispose, resume: () => { stopped = false; connect(); } };
}
