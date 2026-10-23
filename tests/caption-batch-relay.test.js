const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createConfig } = require("../server/config");
const { createSession } = require("../server/state");
const { createSourceBridge, createHostSource } = require("../server/source-relay");

async function setup(t, batchReads) {
  const config = createConfig({ sourceChunkBytes: 16, sourceMaxReads: 1, sourceReadTimeoutMs: 500 });
  const bridge = createSourceBridge(config); await bridge.listen(); t.after(() => bridge.close());
  const messages = [], owner = { clientId: "host" }, state = createSession();
  state.hostId = "host"; state.clients.set("host", { ws: owner });
  let reader;
  const room = { state, transport: { send: (_ws, message) => messages.push(message), broadcast() {} },
    media: { select(url) { state.mediaPath = url; }, prepare(_url, _captions, input) { reader = input; }, reset() {} } };
  const source = createHostSource({ room, bridge, config }); t.after(() => source.reset());
  await source.handleControl(owner, { type: "source-register", video: { id: "video", name: "episode.mkv", size: 100 } });
  const registration = messages.at(-1), socket = new EventEmitter();
  socket.readyState = 1; socket.close = () => { socket.readyState = 3; socket.emit("close"); };
  source.attach(socket, null);
  socket.emit("message", Buffer.from(JSON.stringify({ type: "source-attach", sourceId: registration.sourceId, token: registration.token,
    ...(batchReads ? { capabilities: ["batch-reads-v1"] } : {}) })), false);
  const bytes = Buffer.from(Array.from({ length: 100 }, (_, index) => index));
  function answer(message, corrupt = false) {
    const ranges = message.ranges || [{ offset: message.offset, length: message.length }];
    const body = Buffer.concat(ranges.map(({ offset, length }) => bytes.subarray(offset, offset + length)));
    const frame = Buffer.alloc(4 + body.length - Number(corrupt)); frame.writeUInt32BE(message.requestId); body.copy(frame, 4);
    socket.emit("message", frame, true);
  }
  return { reader, messages, socket, answer, source, room, owner };
}

test("negotiated batches return ordered exact ranges without page expansion", async t => {
  const b = await setup(t, true), signal = new AbortController().signal;
  const promise = b.reader.readMany([{ offset: 3, length: 4 }, { offset: 12, length: 8 }], signal);
  const request = b.messages.at(-1);
  assert.equal(request.type, "source-read-batch");
  assert.deepEqual(request.ranges, [{ offset: 3, length: 4 }, { offset: 12, length: 4 }, { offset: 16, length: 4 }]);
  b.answer(request);
  assert.deepEqual((await promise).map(bytes => [...bytes]), [[3, 4, 5, 6], [12, 13, 14, 15, 16, 17, 18, 19]]);
  assert.deepEqual(b.reader.metrics, { requests: 1, ranges: 3, bytes: 12, cacheHitBytes: 0 });
});

test("providers without batch support use existing read messages", async t => {
  const b = await setup(t, false);
  const promise = b.reader.readMany([{ offset: 3, length: 2 }, { offset: 8, length: 2 }], new AbortController().signal);
  assert.equal(b.messages.at(-1).type, "source-read"); b.answer(b.messages.at(-1));
  assert.equal(b.messages.at(-1).type, "source-read"); b.answer(b.messages.at(-1));
  assert.deepEqual((await promise).map(bytes => [...bytes]), [[3, 4], [8, 9]]);
});

test("cancelled and replaced batch reads reject promptly, and corrupt responses close the provider", async t => {
  const b = await setup(t, true), controller = new AbortController();
  const cancelled = assert.rejects(b.reader.readMany([{ offset: 0, length: 4 }], controller.signal));
  const late = b.messages.at(-1); controller.abort(); await cancelled;
  b.answer(late); assert.equal(b.socket.readyState, 1);
  const replaced = assert.rejects(b.reader.readMany([{ offset: 10, length: 4 }], new AbortController().signal));
  b.source.reset(); await replaced;
  const c = await setup(t, true);
  const corrupt = assert.rejects(c.reader.readMany([{ offset: 0, length: 4 }], new AbortController().signal));
  c.answer(c.messages.at(-1), true); await corrupt;
  assert.equal(c.socket.readyState, 3);
});
