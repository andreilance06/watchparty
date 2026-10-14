const WebSocket = require("ws");

async function connectPeer(url, name) {
  const ws = new WebSocket(url);
  const backlog = [];
  const waiting = [];

  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    const index = waiting.findIndex((item) => item.matches(message));
    if (index < 0) { backlog.push(message); return; }
    const [item] = waiting.splice(index, 1);
    clearTimeout(item.timer);
    item.resolve(message);
  });

  function next(type, predicate = () => true) {
    const matches = (message) => message.type === type && predicate(message);
    const index = backlog.findIndex(matches);
    if (index >= 0) return Promise.resolve(backlog.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const item = { matches, resolve, timer: null };
      item.timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(item), 1);
        reject(new Error(`Timed out waiting for ${type}`));
      }, 10000);
      waiting.push(item);
    });
  }

  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "join", name }));
  const role = await next("role");
  return { ws, role, next, send: (message) => ws.send(JSON.stringify(message)) };
}

module.exports = { connectPeer };
