const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createCaptionSource } = require("../server/media/caption-source");
const { createSubtitleService } = require("../server/media/subtitles");
const { element } = require("../server/media/containers/matroska");
const { riffChunk, riffList } = require("../server/media/containers/legacy");
const { createApplication } = require("../server/application");
const { CPU_ENCODER } = require("../server/encoders");
const { connectPeer, serveHostFiles } = require("./helpers/peer");

function directory(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "watchparty-test-captions-"));
  // Verify our own generated temporary path before recursive cleanup on Windows.
  assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(folder).startsWith("watchparty-test-captions-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}
function ffmpeg(t) {
  const binary = require("ffmpeg-static");
  if (!binary || !fs.existsSync(binary)) { t.skip("FFmpeg is unavailable"); return; }
  return binary;
}
function run(binary, args) {
  return execFileSync(binary, ["-y", "-hide_banner", "-loglevel", "error", ...args], { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
}
function instrument(bytes, controller = new AbortController()) {
  const reads = [];
  const source = createCaptionSource({ size: bytes.length, read: async (offset, length, signal) => {
    signal.throwIfAborted(); reads.push({ offset, length }); return bytes.subarray(offset, offset + length);
  } }, controller.signal);
  return { source, reads, total: () => reads.reduce((sum, read) => sum + read.length, 0) };
}
async function decoded(binary, track, folder, name) {
  const input = await track.extract();
  const filename = path.join(folder, `${name}.${input.extension}`);
  fs.writeFileSync(filename, input.bytes);
  return run(binary, ["-i", filename, "-map", "0:s:0", "-c:s", "ass", "-f", "ass", "pipe:1"]).toString();
}

test("MKV and MP4 relay caption requests skip media payloads and share completed extractions", async t => {
  const binary = ffmpeg(t); if (!binary) return;
  const folder = directory(t), mkv = path.join(folder, "source.mkv"), mp4 = path.join(folder, "source.mp4");
  run(binary, ["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24", "-i", path.join(__dirname, "fixtures/movie.style.ass"),
    "-t", "30", "-map", "0:v", "-map", "1:s", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-c:s", "copy", mkv]);
  run(binary, ["-i", mkv, "-map", "0", "-c:v", "copy", "-c:s", "mov_text", mp4]);
  const app = createApplication({ config: { port: 0 }, encoderPromise: Promise.resolve(CPU_ENCODER) });
  const address = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`, host = await connectPeer(base.replace("http", "ws"), "Host");
  for (const filename of [mkv, mp4]) {
    const bytes = fs.readFileSync(filename);
    assert.ok(bytes.length > app.config.sourceCacheBytes);
    const relay = await serveHostFiles(host, base, { name: path.basename(filename), bytes });
    const ready = await host.next("session-state", message => message.hasVideo && message.fileName === path.basename(filename));
    const before = relay.reads.reduce((sum, read) => sum + read.length, 0);
    const captionUrl = base + ready.captions[0].url;
    const captions = await Promise.all([fetch(captionUrl).then(response => response.text()), fetch(captionUrl).then(response => response.text())]);
    assert.match(captions[0], /Styled caption/);
    assert.equal(captions[1], captions[0]);
    const after = relay.reads.reduce((sum, read) => sum + read.length, 0);
    assert.ok(after - before < bytes.length * 0.05, `${path.extname(filename)} fetched ${after - before} of ${bytes.length} bytes for captions`);
    t.diagnostic(`${path.extname(filename)}: ${after - before} additional caption bytes / ${bytes.length} video bytes`);
    const count = relay.reads.length;
    assert.equal(await (await fetch(captionUrl)).text(), captions[0]);
    assert.equal(relay.reads.length, count, "a cached caption never rereads the video");
    assert.equal(app.state.mediaReady, true);
    assert.equal(app.state.playback.paused, true);
    const videoId = relay.files.keys().next().value;
    const videoReads = relay.reads.filter(read => read.fileId === videoId).length;
    const added = relay.declare({ name: "extra.srt", bytes: fs.readFileSync(path.join(__dirname, "fixtures/captions.srt")) });
    host.send({ type: "captions-add", sourceId: relay.sourceId, files: [added] });
    await host.next("captions-managed");
    assert.equal(relay.reads.filter(read => read.fileId === videoId).length, videoReads, "external captions never trigger another video extraction");
  }
});

test("ISO sample tables, edit offsets, tail metadata, and fragments preserve subtitle timing", async t => {
  const binary = ffmpeg(t); if (!binary) return;
  const folder = directory(t), subtitles = path.join(folder, "cues.srt");
  fs.writeFileSync(subtitles, "1\n00:00:02,000 --> 00:00:05,000\nFirst cue\n\n2\n00:00:07,500 --> 00:00:09,250\nLate cue\n");
  for (const [name, flags] of [["tail.mp4", []], ["head.m4v", ["-movflags", "+faststart"]], ["fragmented.mp4", ["-movflags", "+frag_keyframe+empty_moov+default_base_moof"]],
    ["absolute-fragments.mp4", ["-movflags", "+frag_keyframe+empty_moov"]], ["quicktime.mov", []], ["phone.3gp", []], ["phone.3g2", []]]) {
    const filename = path.join(folder, name);
    run(binary, ["-f", "lavfi", "-i", "color=size=160x90:rate=10", "-itsoffset", "1", "-i", subtitles,
      "-t", "12", "-map", "0:v", "-map", "1:s", "-c:v", "libx264", "-g", "10", "-c:s", "mov_text", ...flags, filename]);
    const bytes = fs.readFileSync(filename), measured = instrument(bytes);
    const catalog = await measured.source.discover();
    assert.equal(catalog.tracks.length, 1, name);
    const actual = await decoded(binary, catalog.tracks[0], folder, `extracted-${name}`);
    const expected = run(binary, ["-i", filename, "-map", "0:s:0", "-c:s", "ass", "-f", "ass", "pipe:1"]).toString();
    if (name.includes("fragment")) {
      // This FFmpeg build reports zero packet durations when directly decoding
      // fragmented mov_text. The stored sample durations are authoritative.
      assert.match(actual, /0:00:03.20,0:00:08.70.*First cue/, name);
      assert.match(actual, /0:00:08.70,0:00:10.45.*Late cue/, name);
    } else assert.deepEqual(actual.match(/^Dialogue:.*$/gm), expected.match(/^Dialogue:.*$/gm), name);
  }
});

test("Matroska shares its block index across tracks and preserves ASS styles and fonts", async t => {
  const binary = ffmpeg(t); if (!binary) return;
  const folder = directory(t), filename = path.join(folder, "styled.mkv");
  run(binary, ["-f", "lavfi", "-i", "color=size=160x90:rate=10", "-i", path.join(__dirname, "fixtures/movie.style.ass"),
    "-i", path.join(__dirname, "fixtures/captions.srt"), "-t", "5", "-map", "0:v", "-map", "1:s", "-map", "2:s", "-c:v", "libx264", "-c:s", "copy",
    "-attach", path.join(__dirname, "../vendor/jassub/default.woff2"), "-metadata:s:t", "filename=test.ttf", "-metadata:s:t", "mimetype=application/x-truetype-font", filename]);
  const measured = instrument(fs.readFileSync(filename));
  const catalog = await measured.source.discover();
  assert.equal(catalog.tracks.length, 2);
  assert.equal(catalog.fonts.length, 1);
  const actual = await decoded(binary, catalog.tracks[0], folder, "styled");
  assert.match(actual, /Style: Default,Arial,14/);
  assert.match(actual, /0:00:00.50,0:00:03.00.*Styled caption/);
  const before = measured.reads.length;
  await decoded(binary, catalog.tracks[1], folder, "second");
  assert.ok(measured.reads.length - before < 15, "another track reads subtitle blocks, not all media headers again");
  assert.deepEqual(await catalog.fonts[0].load(), fs.readFileSync(path.join(__dirname, "../vendor/jassub/default.woff2")));
});

test("WebM embedded WebVTT is extracted through the EBML adapter", async t => {
  const binary = ffmpeg(t); if (!binary) return;
  const folder = directory(t), filename = path.join(folder, "video.webm"), caption = path.join(folder, "captions.vtt");
  fs.writeFileSync(caption, "WEBVTT\n\n00:00:00.500 --> 00:00:02.000\nWebM caption\n");
  run(binary, ["-f", "lavfi", "-i", "color=size=160x90:rate=10", "-i", caption, "-t", "3", "-c:v", "libvpx-vp9", "-c:s", "webvtt", filename]);
  const measured = instrument(fs.readFileSync(filename));
  const catalog = await measured.source.discover();
  assert.equal(catalog.tracks.length, 1);
  assert.match(await decoded(binary, catalog.tracks[0], folder, "webm"), /0:00:00.50,0:00:02.00.*WebM caption/);
});

function aviFixture({ indexed = false, openDml = false, plainText = false } = {}) {
  const avih = Buffer.alloc(56), video = Buffer.alloc(56), subtitles = Buffer.alloc(56);
  avih.writeUInt32LE(100000, 0); avih.writeUInt32LE(100, 16); avih.writeUInt32LE(2, 24); avih.writeUInt32LE(160, 32); avih.writeUInt32LE(90, 36);
  video.write("vids"); video.write("MJPG", 4); video.writeUInt32LE(1, 20); video.writeUInt32LE(10, 24); video.writeUInt32LE(100, 32);
  subtitles.write("txts"); subtitles.writeUInt32LE(1, 20); subtitles.writeUInt32LE(1000, 24); subtitles.writeUInt32LE(10000, 32);
  if (plainText) { subtitles.writeUInt32LE(1000, 20); subtitles.writeUInt32LE(2, 28); }
  const strf = Buffer.alloc(40); strf.writeUInt32LE(40); strf.writeInt32LE(160, 4); strf.writeInt32LE(90, 8); strf.writeUInt16LE(1, 12); strf.writeUInt16LE(24, 14); strf.write("MJPG", 16);
  const desc = Buffer.from("English\0", "utf16le"), text = fs.readFileSync(path.join(__dirname, "fixtures/movie.style.ass"));
  const head = Buffer.alloc(11); head.write("GAB2\0", "ascii"); head.writeUInt16LE(2, 5); head.writeUInt32LE(desc.length, 7);
  const tail = Buffer.alloc(6); tail.writeUInt32LE(text.length, 2);
  const gab = plainText ? Buffer.from("Plain AVI text") : Buffer.concat([head, desc, tail, text]);
  const videoChunk = riffChunk("00dc", Buffer.alloc(20 * 1024 * 1024, 0x55)), subtitleChunk = riffChunk("01tx", gab);
  const index = Buffer.alloc(32); index.write("00dc"); index.writeUInt32LE(4, 8); index.writeUInt32LE(videoChunk.length - 8, 12);
  index.write("01tx", 16); index.writeUInt32LE(4 + videoChunk.length, 24); index.writeUInt32LE(gab.length, 28);
  const superindex = Buffer.alloc(40); superindex.writeUInt16LE(4); superindex.writeUInt32LE(1, 4); superindex.write("01tx", 8);
  const hdrl = () => riffList("hdrl", [riffChunk("avih", avih), riffList("strl", [riffChunk("strh", video), riffChunk("strf", strf)]),
    riffList("strl", [riffChunk("strh", subtitles), riffChunk("strf", Buffer.alloc(0)), ...(openDml ? [riffChunk("indx", superindex)] : [])])]);
  const movie = riffList("movi", [videoChunk, subtitleChunk]);
  const subtitleAt = 12 + hdrl().length + 12 + videoChunk.length;
  const standard = Buffer.alloc(32); standard.writeUInt16LE(2); standard[3] = 1; standard.writeUInt32LE(1, 4); standard.write("01tx", 8);
  standard.writeBigUInt64LE(BigInt(subtitleAt + 8), 12); standard.writeUInt32LE(0, 24); standard.writeUInt32LE(gab.length, 28);
  superindex.writeBigUInt64LE(BigInt(12 + hdrl().length + movie.length), 24); superindex.writeUInt32LE(40, 32);
  return riffChunk("RIFF", Buffer.concat([Buffer.from("AVI "), hdrl(), movie, ...(indexed ? [riffChunk("idx1", index)] : []), ...(openDml ? [riffChunk("ix01", standard)] : [])]));
}

test("AVI GAB2 captions work with RIFF walking, idx1, and OpenDML without fetching video chunks", async t => {
  const binary = ffmpeg(t); if (!binary) return;
  const folder = directory(t);
  for (const options of [{}, { indexed: true }, { openDml: true }]) {
    const bytes = aviFixture(options), measured = instrument(bytes);
    const catalog = await measured.source.discover();
    assert.equal(catalog.tracks.length, 1);
    assert.match(await decoded(binary, catalog.tracks[0], folder, `avi-${JSON.stringify(options).replace(/\W/g, "")}`), /Styled caption/);
    assert.ok(measured.total() < bytes.length * 0.05);
    assert.ok(measured.reads.every(read => read.length < 8192));
  }
});

test("AVI text packets use the stream start, scale, and rate", async t => {
  const binary = ffmpeg(t); if (!binary) return;
  const measured = instrument(aviFixture({ plainText: true })), folder = directory(t);
  const catalog = await measured.source.discover();
  assert.match(await decoded(binary, catalog.tracks[0], folder, "plain-avi"), /0:00:02.00,0:00:03.00.*Plain AVI text/);
});

test("unknown-sized Matroska segments and clusters still skip video blocks", async t => {
  const binary = ffmpeg(t); if (!binary) return;
  const folder = directory(t);
  const entry = (number, type, codec) => element("ae", Buffer.concat([
    element("d7", Buffer.from([number])), element("83", Buffer.from([type])), element("86", Buffer.from(codec))
  ]));
  const header = element("1a45dfa3", Buffer.concat([element("4286", Buffer.from([1])), element("42f7", Buffer.from([1])),
    element("42f2", Buffer.from([4])), element("42f3", Buffer.from([8])), element("4282", Buffer.from("matroska")), element("4287", Buffer.from([4])), element("4285", Buffer.from([2]))]));
  const group = element("a0", Buffer.concat([element("a1", Buffer.concat([Buffer.from([0x82, 0, 0, 0]), Buffer.from("Unknown cluster caption")])), element("9b", Buffer.from([0x0b, 0xb8]))]));
  const bytes = Buffer.concat([header, Buffer.from("1853806701ffffffffffffff", "hex"), element("1654ae6b", Buffer.concat([entry(1, 1, "V_MPEG4/ISO/AVC"), entry(2, 17, "S_TEXT/UTF8")])),
    Buffer.from("1f43b67501ffffffffffffff", "hex"), element("e7", Buffer.from([0])), element("a3", Buffer.concat([Buffer.from([0x81, 0, 0, 0]), Buffer.alloc(20 * 1024 * 1024)])),
    group, element("1f43b675", element("e7", Buffer.from([0x0f, 0xa0]))) ]);
  const measured = instrument(bytes), catalog = await measured.source.discover();
  assert.match(await decoded(binary, catalog.tracks[0], folder, "unknown-ebml"), /0:00:00.00,0:00:03.00.*Unknown cluster caption/);
  assert.ok(measured.total() < bytes.length * 0.05);
});

function oggPage(serial, sequence, flags, granule, laces, payload) {
  const header = Buffer.alloc(27); header.write("OggS"); header[5] = flags; header.writeBigInt64LE(BigInt(granule), 6);
  header.writeUInt32LE(serial, 14); header.writeUInt32LE(sequence, 18); header[26] = laces.length;
  const page = Buffer.concat([header, Buffer.from(laces), payload]);
  let crc = 0;
  for (const byte of page) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  page.writeUInt32LE(crc >>> 0, 22);
  return page;
}
function oggFixture() {
  const header = Buffer.alloc(53); header[0] = 1; header.write("text", 1); header.writeUInt32LE(52, 13);
  header.writeBigUInt64LE(10000n, 17); header.writeBigUInt64LE(1n, 25);
  const comment = Buffer.from("\x03vorbis\0\0\0\0\0\0\0\0\x01", "binary");
  const packet = Buffer.concat([Buffer.from([0x80, 0xd0, 0x07]), Buffer.from("Continued OGM caption " + "x".repeat(300))]);
  const pages = [oggPage(7, 0, 2, 0, [header.length], header),
    oggPage(9, 0, 2, 0, [64], Buffer.alloc(64, 0x55)),
    oggPage(7, 1, 0, 0, [comment.length], comment), oggPage(7, 2, 0, -1, [255], packet.subarray(0, 255))];
  // A large unrelated logical stream with valid page framing.
  for (let i = 1; i <= 330; i++) pages.push(oggPage(9, i, 0, i, Array(255).fill(255), Buffer.alloc(65025, 0x55)));
  pages.push(oggPage(7, 3, 5, 500, [packet.length - 255], packet.subarray(255)));
  return Buffer.concat(pages);
}

test("Ogg/OGM extraction keeps subtitle granules, CRCs, and continued packets while skipping other streams", async t => {
  const binary = ffmpeg(t); if (!binary) return;
  const folder = directory(t), bytes = oggFixture(), measured = instrument(bytes);
  const catalog = await measured.source.discover();
  assert.equal(catalog.tracks.length, 1);
  assert.match(await decoded(binary, catalog.tracks[0], folder, "ogm"), /Continued OGM caption/);
  assert.ok(measured.total() < bytes.length * 0.05);
  assert.ok(measured.reads.every(read => read.length < 8192));
});

test("unknown, malformed, truncated, and cancelled sources fail without a video scan", async () => {
  for (const bytes of [Buffer.alloc(20 * 1024 * 1024), Buffer.from("\x1a\x45\xdf\xa3\xff\0\0\0", "binary"), Buffer.from("\0\0\0\x40moov12345678", "binary"), Buffer.from("OggS\0\0\0\0", "binary")]) {
    const measured = instrument(bytes);
    await assert.rejects(measured.source.discover());
    assert.ok(measured.total() < 128);
  }
  const controller = new AbortController(), measured = instrument(aviFixture(), controller);
  controller.abort();
  await assert.rejects(measured.source.discover(), { name: "AbortError" });
  assert.equal(measured.reads.length, 0);
});

test("unsupported embedded captions never invoke FFmpeg on the original file", async t => {
  const folder = directory(t), bytes = Buffer.alloc(20 * 1024 * 1024), reads = [];
  const state = { hlsDirectory: folder, mediaVersion: 1, mediaPath: "http://127.0.0.1/original" };
  // A nonexistent binary makes any accidental FFmpeg fallback observable.
  const service = createSubtitleService({ state, config: { ffmpegPath: "must-not-be-executed" } });
  t.after(() => service.stop());
  service.setSource({ size: bytes.length, read: async (offset, length) => { reads.push(length); return bytes.subarray(offset, offset + length); } });
  service.register({ id: "unsupported", input: state.mediaPath, map: "0:1", fileName: "captions_0.ass", codec: "subrip" }, 1);
  await assert.rejects(service.wait("captions_0.ass"), /Add an external/);
  assert.deepEqual(reads, [16]);
  assert.deepEqual(fs.readdirSync(folder), []);
});

test("replacing a source aborts in-flight caption reads and leaves no obsolete output", async t => {
  const folder = directory(t);
  const state = { hlsDirectory: folder, mediaVersion: 1, mediaPath: "http://127.0.0.1/original" };
  const service = createSubtitleService({ state, config: { ffmpegPath: "must-not-be-executed" } });
  t.after(() => service.stop());
  let entered, aborted = false;
  const started = new Promise(resolve => { entered = resolve; });
  service.setSource({ size: 10000, read: (_offset, _length, signal) => new Promise((_resolve, reject) => {
    entered();
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
  }) });
  service.register({ id: "old", input: state.mediaPath, map: "0:1", fileName: "captions_0.ass", codec: "ass" }, 1);
  const oldJob = service.wait("captions_0.ass");
  const rejected = assert.rejects(oldJob, { name: "AbortError" });
  await started;
  state.mediaVersion++;
  service.stop();
  await rejected;
  assert.equal(aborted, true);
  assert.deepEqual(fs.readdirSync(folder), []);
});
