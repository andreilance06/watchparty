const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createConfig } = require("../server/config");
const { createSession } = require("../server/state");
const { createSourceBridge, createHostSource, validateFile } = require("../server/source-relay");

test("loopback source bridge implements bounded exact reads and HTTP ranges", async (t) => {
  const bridge = createSourceBridge(createConfig({ sourceChunkBytes: 3 }));
  await bridge.listen();
  t.after(() => bridge.close());
  const bytes = Buffer.from("0123456789"), reads = [];
  const registered = bridge.register({ files: new Map([["video", { size: bytes.length }]]), read: async (_, offset, length) => {
    reads.push({ offset, length }); return bytes.subarray(offset, offset + length);
  } });
  const url = registered.url("video");
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.headers.get("content-length"), "10");
  assert.equal(await head.text(), "");
  assert.equal(reads.length, 0);
  const range = await fetch(url, { headers: { Range: "bytes=2-7" } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), "bytes 2-7/10");
  assert.equal(await range.text(), "234567");
  assert.ok(reads.every((read) => read.length <= 3));
  assert.equal(await (await fetch(url, { headers: { Range: "bytes=-2" } })).text(), "89");
  assert.equal(await (await fetch(url, { headers: { Range: "bytes=8-" } })).text(), "89");
  assert.equal(await (await fetch(url)).text(), "0123456789");
  for (const value of ["bytes=100-", "bytes=4-2", "bytes=0-1,3-4", "garbage", "bytes=-0"]) {
    assert.equal((await fetch(url, { headers: { Range: value } })).status, 416);
  }
  assert.equal((await fetch(url.replace(/\/[^/]+\/video$/, "/wrong/video"))).status, 404);
  registered.close();
  assert.equal((await fetch(url)).status, 404);
});

test("host relay bounds concurrent reads, rejects corrupt frames, and closes pending reads", async (t) => {
  const config = createConfig({ sourceChunkBytes: 16, sourceMaxReads: 2, sourceReadTimeoutMs: 100 });
  const bridge = createSourceBridge(config);
  await bridge.listen();
  t.after(() => bridge.close());
  const sent = [];
  const state = createSession();
  const owner = { clientId: "host" };
  state.hostId = "host"; state.clients.set("host", { ws: owner });
  const room = { state, transport: { send: (_, message) => sent.push(message), broadcast() {} },
    media: { select: (url) => { state.mediaPath = url; }, prepare() {}, reset() {} } };
  const source = createHostSource({ room, bridge, config });
  t.after(() => source.reset());
  await source.handleControl(owner, { type: "source-register", video: { id: "video", name: "movie.mkv", size: 100 } });
  const registration = sent.at(-1);
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.close = () => { socket.readyState = 3; socket.emit("close"); };
  source.attach(socket, null);
  socket.emit("message", Buffer.from(JSON.stringify({ type: "source-attach", sourceId: registration.sourceId, token: registration.token })), false);
  const get = () => fetch(state.mediaPath, { headers: { Range: "bytes=0-15" } }).then((response) => response.arrayBuffer());
  const operations = Promise.allSettled([get(), get(), get()]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sent.filter((message) => message.type === "source-read").length, 1, "identical reads share one host request");
  const first = sent.find((message) => message.type === "source-read");
  const corrupt = Buffer.alloc(5); corrupt.writeUInt32BE(first.requestId);
  socket.emit("message", corrupt, true);
  assert.equal(socket.readyState, 3);
  const results = await operations;
  assert.ok(results.every((result) => result.status === "rejected"));
});

test("file declarations accept only safe sizes, IDs, and supported sidecar types", () => {
  for (const file of [{ id: "../bad", name: "video", size: 1 }, { id: "x", name: "video", size: -1 }, { id: "x", name: "video", size: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => validateFile(file));
  }
  assert.throws(() => validateFile({ id: "caption", name: "caption.exe", size: 10 }, true));
  assert.equal(validateFile({ id: "caption", name: "C:\\private\\captions.srt", size: 10 }, true).name, "captions.srt");
});

test("unanswered host reads time out and late responses cannot satisfy other requests", async (t) => {
  const config = createConfig({ sourceReadTimeoutMs: 50 });
  const bridge = createSourceBridge(config);
  await bridge.listen();
  t.after(() => bridge.close());
  const sent = [], owner = { clientId: "host" }, state = createSession();
  state.hostId = "host"; state.clients.set("host", { ws: owner });
  const room = { state, transport: { send: (_, message) => sent.push(message), broadcast() {} },
    media: { select: (url) => { state.mediaPath = url; }, prepare() {}, reset() {} } };
  const source = createHostSource({ room, bridge, config });
  t.after(() => source.reset());
  await source.handleControl(owner, { type: "source-register", video: { id: "video", name: "movie.mkv", size: 100 } });
  const registration = sent.at(-1);
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.close = () => { socket.readyState = 3; socket.emit("close"); };
  source.attach(socket, null);
  socket.emit("message", Buffer.from(JSON.stringify({ type: "source-attach", sourceId: registration.sourceId, token: registration.token })), false);
  await assert.rejects(async () => (await fetch(state.mediaPath)).arrayBuffer());
  const expired = sent.find((message) => message.type === "source-read");
  const late = Buffer.alloc(4 + expired.length); late.writeUInt32BE(expired.requestId);
  socket.emit("message", late, true);
  assert.equal(socket.readyState, 1);
  const pending = fetch(state.mediaPath).then((response) => response.arrayBuffer());
  const failure = assert.rejects(pending);
  for (let i = 0; i < 10 && sent.filter((message) => message.type === "source-read").length < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(sent.filter((message) => message.type === "source-read").length, 2);
  source.reset();
  await failure;
});
