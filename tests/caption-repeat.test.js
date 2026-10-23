const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createEpisode } = require("./helpers/matroska-episode");
const { createApplication } = require("../server/application");
const { CPU_ENCODER } = require("../server/encoders");
const { connectPeer, serveHostFiles } = require("./helpers/peer");

test("episode caption readiness stays bounded across replacement, playback reads and concurrent rooms", async t => {
  const binary = require("ffmpeg-static");
  if (!binary || !fs.existsSync(binary)) { t.skip("FFmpeg is unavailable"); return; }
  const app = createApplication({ config: { port: 0, sourceCacheBytes: 1024 * 1024 }, encoderPromise: Promise.resolve(CPU_ENCODER) });
  const address = await app.listen(); t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  const first = { host: await connectPeer(base.replace("http", "ws"), "Public"), state: app.state, headers: {} };
  async function room(name) {
    const response = await fetch(base + "/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    assert.equal(response.status, 201);
    const session = await response.json(), cookie = response.headers.get("set-cookie").split(";")[0];
    const headers = { Cookie: cookie };
    return { host: await connectPeer(base.replace("http", "ws") + session.endpoints.websocket, name, { headers }), state: app.rooms.get(session.room.id).state, headers };
  }
  const fixtureA = createEpisode(), fixtureB = createEpisode({ subtitle: "Different episode" });
  const timings = [];
  async function select(target, fixture, playback = false) {
    const previous = target.state.mediaVersion;
    const bytes = { length: fixture.size, copy: (output, at, start, end) => fixture.read(start, end - start).copy(output, at) };
    await serveHostFiles(target.host, base, { name: "episode.mkv", bytes }, [], { headers: target.headers });
    const ready = await target.host.next("session-state", message => message.hasVideo && message.mediaVersion > previous);
    const started = performance.now();
    const original = playback ? fetch(base + ready.originalUrl, { headers: { ...target.headers, Range: "bytes=9000000-13194303" } }).then(response => response.arrayBuffer()) : Promise.resolve();
    const response = await fetch(base + ready.captions[0].url, { headers: target.headers });
    const content = await response.text();
    assert.equal(response.status, 200, content);
    assert.match(content, fixture === fixtureA ? /Episode caption 359/ : /Different episode 359/);
    const metrics = JSON.parse(response.headers.get("X-WatchParty-Caption-Metrics"));
    assert.equal(metrics.indexMode, "cues");
    assert.ok(metrics.requests < 100, JSON.stringify(metrics));
    const elapsed = performance.now() - started; timings.push(elapsed);
    assert.ok(elapsed < 5000, `caption readiness took ${elapsed} ms`);
    await original;
    assert.equal(target.state.mediaReady, true);
    return content;
  }
  await select(first, fixtureA);
  await select(first, fixtureA, true);
  await select(first, fixtureB, true);
  const second = await room("Second episode room"), third = await room("Third episode room");
  await Promise.all([select(second, fixtureA, true), select(third, fixtureB, true)]);
  await select(first, fixtureA, true);
  t.diagnostic(`caption readiness across six selections/three rooms: ${timings.map(value => Math.round(value)).join(", ")} ms`);
});
