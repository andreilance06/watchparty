// Transport only: features decide which messages to send and how to apply them.
export function createConnection({ getIdentity, onMessage, onStatus, onBlocked = () => {}, beforeReconnect, path = "/" }) {
  let socket;
  let reconnectTimer;
  let stopped = false;
  let resumeClientId;
  let resumeToken;
  let resumeName;
  let retryDelay = 1500;
  const storageKey = `watchparty-connection:${path}`;
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");
    if (typeof saved?.clientId === "string" && typeof saved?.token === "string") {
      resumeClientId = saved.clientId; resumeToken = saved.token;
      if (typeof saved.name === "string") resumeName = saved.name;
    }
  } catch { /* Storage is optional; in-page reconnects still work. */ }

  function rememberConnection() {
    if (!resumeToken) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify({ clientId: resumeClientId, token: resumeToken, name: resumeName })); }
    catch { /* Storage is optional. */ }
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(reconnect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  }

  function send(payload) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }

  function connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL(`${protocol}//${location.host}${path}`);
    if (resumeClientId) url.searchParams.set("resumeClientId", resumeClientId);
    if (resumeToken) url.searchParams.set("resumeToken", resumeToken);
    socket = new WebSocket(url.href);
    socket.addEventListener("open", () => {
      onStatus(true, "Connected");
      send({ type: "join", ...getIdentity(), ...(resumeName ? { name: resumeName } : {}) });
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "role") {
        resumeClientId = message.clientId;
        if (message.resumeToken) resumeToken = message.resumeToken;
        if (typeof message.name === "string") resumeName = message.name;
        retryDelay = 1500;
        rememberConnection();
      }
      if (["name-updated", "name-rejected"].includes(message.type) && typeof message.name === "string") {
        resumeName = message.name;
        rememberConnection();
      }
      if (message.type === "room-blocked") { stopped = true; clearTimeout(reconnectTimer); }
      onMessage(message);
    });
    socket.addEventListener("close", (event) => {
      if (event.code === 4000) stopped = true;
      if (event.code === 4003) stopped = true;
      onStatus(false, event.code === 4000 ? "Connected in another tab" : "Disconnected");
      if (event.code === 4003) onBlocked();
      if (!stopped) scheduleReconnect();
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
      if (!stopped) scheduleReconnect();
    }
  }

  function dispose() {
    stopped = true;
    clearTimeout(reconnectTimer);
    socket?.close();
  }

  return { connect, send, dispose, resume: () => { stopped = false; connect(); } };
}
