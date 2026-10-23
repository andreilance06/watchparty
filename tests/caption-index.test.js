const test = require("node:test");
const assert = require("node:assert/strict");
const { createCaptionSource } = require("../server/media/caption-source");
const { createEpisode } = require("./helpers/matroska-episode");
const { setTimeout: delay } = require("node:timers/promises");

function provider(fixture, { latency = 0, batches = true } = {}) {
  const metrics = { requests: 0, ranges: 0, bytes: 0, cacheHitBytes: 0 };
  const controller = new AbortController();
  const read = async (offset, length, signal) => {
    metrics.requests++; metrics.ranges++; metrics.bytes += length;
    if (latency) await delay(latency, null, { signal });
    return fixture.read(offset, length);
  };
  const source = { size: fixture.size, metrics, read };
  if (batches) source.readMany = async (ranges, signal) => {
    assert.ok(ranges.length <= 64);
    assert.ok(ranges.reduce((sum, range) => sum + range.length, 0) <= 256 * 1024);
    metrics.requests++; metrics.ranges += ranges.length;
    if (latency) await delay(latency, null, { signal });
    return ranges.map(({ offset, length }) => { metrics.bytes += length; return fixture.read(offset, length); });
  };
  return { source: createCaptionSource(source, controller.signal), metrics, controller };
}

test("episode-scale subtitle cues avoid media-block traversal and retain 64-bit TrackUIDs", async t => {
  const fixture = createEpisode(), measured = provider(fixture, { latency: 1 });
  const start = performance.now(), catalog = await measured.source.discover();
  assert.equal(catalog.tracks[0].uid, fixture.uid.toString());
  const extracted = await catalog.tracks[0].extract();
  assert.equal(extracted.indexMode, "cues");
  for (const payload of fixture.payloads) assert.ok(extracted.bytes.includes(payload));
  assert.equal(catalog.tracks[0].structuralPackets.length, 0);
  assert.deepEqual(await catalog.fonts[0].load(), fixture.fontBytes);
  assert.ok(measured.metrics.requests < 100, `too many relay requests: ${measured.metrics.requests}`);
  assert.ok(measured.metrics.bytes < fixture.size * 0.05);
  assert.ok(performance.now() - start < 5000);
  t.diagnostic(`${fixture.size} bytes, ${fixture.cueCount} cues: ${measured.metrics.requests} requests, ${measured.metrics.ranges} ranges, ${measured.metrics.bytes} bytes`);
});

test("missing, partial, duplicate, stale and malformed indexes preserve all captions using structural traversal", async () => {
  for (const options of [{ indexed: false }, { statistics: false }, { partialCues: true }, { duplicateCue: true }, { wrongUid: true }, { invalidOffset: true }, { invalidSeek: true }]) {
    const fixture = createEpisode({ clusterCount: 6, ...options }), measured = provider(fixture);
    const catalog = await measured.source.discover(), extracted = await catalog.tracks[0].extract();
    assert.equal(extracted.indexMode, options.invalidSeek ? "cues" : "structural", JSON.stringify(options));
    for (const payload of fixture.payloads) assert.ok(extracted.bytes.includes(payload), JSON.stringify(options));
    assert.ok(measured.metrics.bytes < fixture.size * 0.05);
  }
});

test("indexed extraction matches complete structural extraction including overlapping and late cues", async () => {
  const indexed = provider(createEpisode()), structural = provider(createEpisode({ indexed: false }));
  const [fastCatalog, completeCatalog] = await Promise.all([indexed.source.discover(), structural.source.discover()]);
  const [fast, complete] = await Promise.all([fastCatalog.tracks[0].extract(), completeCatalog.tracks[0].extract()]);
  assert.equal(fast.indexMode, "cues");
  assert.equal(complete.indexMode, "structural");
  assert.deepEqual(fast.bytes, complete.bytes);
});

test("older providers without batch capability still extract indexed captions", async () => {
  const fixture = createEpisode({ clusterCount: 12 }), measured = provider(fixture, { batches: false });
  const catalog = await measured.source.discover(), extracted = await catalog.tracks[0].extract();
  assert.equal(extracted.indexMode, "cues");
  for (const payload of fixture.payloads) assert.ok(extracted.bytes.includes(payload));
});

test("source cancellation interrupts batched index reads", async () => {
  const measured = provider(createEpisode(), { latency: 10 });
  const job = measured.source.discover();
  const rejected = assert.rejects(job, { name: "AbortError" });
  measured.controller.abort();
  await rejected;
});
