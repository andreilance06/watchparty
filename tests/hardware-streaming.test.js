const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { resolveFfmpeg } = require("../server/ffmpeg");
const { detectVideoEncoder } = require("../server/encoders");
const { createSegmentService } = require("../server/media/segments");
const { probeMedia } = require("../server/media/probe");
const { resolveFfprobe } = require("../server/ffprobe");
const { inspectIso } = require("../server/media/containers/iso-metadata");
const { isoVideoCodec } = require("../server/media/video-codec");

async function fixture(t, hdr = false) {
  let selected;
  try { selected = await resolveFfmpeg(); } catch { t.skip("FFmpeg unavailable"); return; }
  const encoder = await detectVideoEncoder(selected.path, selected);
  if (encoder.name !== "h264_nvenc") { t.skip("NVIDIA GPU unavailable; backend construction is covered separately"); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "watchparty-hardware-"));
  const services = [];
  t.after(async () => {
    await Promise.all(services.map(service => service.cancel()));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const source = path.join(directory, "source.mp4");
  execFileSync(selected.path, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=60",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "4", "-c:v", hdr ? "libx265" : "libx264", "-preset", "ultrafast",
    ...(hdr ? ["-pix_fmt", "yuv420p10le", "-x265-params", "colorprim=9:transfer=16:colormatrix=9", "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc", "-tag:v", "hvc1"] : []),
    "-c:a", "aac", "-movflags", "+faststart", source], { stdio: "pipe", windowsHide: true, timeout: 20000 });
  const { info } = await probeMedia(source, (await resolveFfprobe()).path, new AbortController().signal, source);
  return { directory, source, selected, encoder, info, services };
}

function service(t, source, spawnEncoder = spawn) {
  const state = { mediaVersion: 1, streamGeneration: 0, hlsDirectory: source.directory, mediaPath: source.source, mediaDuration: 4,
    mediaInfo: source.info, rendition: source.rendition || { width: 320, height: 180, bitrate: 750000 },
    playback: { paused: true, time: 0, rate: 1, updatedAt: Date.now() } };
  const events = [], calls = [];
  const segments = createSegmentService({ state, config: { segmentSeconds: 2, maxSegmentsAhead: 2, ffmpegPath: source.selected.path },
    encoderPromise: Promise.resolve(source.encoder), broadcast: message => events.push(message),
    spawnEncoder: (...args) => { calls.push(args[1]); return spawnEncoder(...args); } });
  source.services.push(segments);
  return { state, events, calls, segments };
}

test("NVIDIA streaming decodes, scales, and encodes on GPU with bounded pause/seek output and audible AAC", { timeout: 30000 }, async t => {
  const source = await fixture(t); if (!source) return;
  const { segments, calls, events, state } = service(t, source);
  const first = await segments.ensure(0);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("cuda")); assert.match(calls[0][calls[0].indexOf("-vf") + 1], /^scale_cuda=/);
  assert.match(events.find(event => event.type === "transcode-info").encoder, /hardware decode \+ GPU scale \+ hardware encode/);
  const probe = require("node:child_process").spawnSync(source.selected.path, ["-hide_banner", "-i", first, "-frames:v", "1", "-f", "null", "-"], { encoding: "utf8", windowsHide: true });
  assert.equal(probe.status, 0, probe.stderr); assert.match(probe.stderr, /Video: h264.*320x180/);
  assert.match(probe.stderr, /30 fps/); assert.match(probe.stderr, /Audio: aac.*48000 Hz, stereo/);
  const pcm = execFileSync(source.selected.path, ["-hide_banner", "-loglevel", "error", "-i", first, "-vn", "-f", "f32le", "-ac", "1", "-"], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
  assert.ok(samples.some(sample => Math.abs(sample) > 0.03), "AAC output contains audible signal");
  assert.equal(fs.existsSync(path.join(path.dirname(first), "segment_000001.ts")), false, "paused output is bounded");
  await segments.cancel();
  state.playback.time = 3; segments.restart();
  await segments.ensure(1);
  assert.equal(state.streamGeneration, 1);
});

test("NVIDIA HDR streaming performs GPU tone mapping and publishes SDR H264", { timeout: 30000 }, async t => {
  const source = await fixture(t, true); if (!source) return;
  if (!source.selected.filters.has("libplacebo")) return t.skip("libplacebo unavailable; CPU HDR fallback is covered by streaming tests");
  const { segments, events } = service(t, source);
  const output = await segments.ensure(0);
  assert.match(events.find(event => event.type === "transcode-info").encoder, /hardware decode \+ GPU tone map\/scale \+ hardware encode/);
  const probe = require("node:child_process").spawnSync(source.selected.path, ["-hide_banner", "-i", output, "-frames:v", "1", "-f", "null", "-"], { encoding: "utf8", windowsHide: true });
  assert.equal(probe.status, 0, probe.stderr); assert.match(probe.stderr, /Video: h264.*yuv420p.*bt709.*320x180/);
  assert.doesNotMatch(probe.stderr, /smpte2084|arib-std-b67/);
  const bytes = fs.readFileSync(source.source);
  const metadata = await inspectIso({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) });
  assert.match(isoVideoCodec(metadata), /^hvc1\.2\.[\dA-F]+\.L\d+(?:\.[\dA-F]{2})*$/);
});

test("NVIDIA Source fallback retains GPU processing, source size and frame rate with uncapped quality", { timeout: 30000 }, async t => {
  const source = await fixture(t); if (!source) return;
  source.rendition = require('../server/media/quality').resolveQuality(source.info, 'source', 'source');
  const { segments, calls, events } = service(t, source);
  const output = await segments.ensure(0);
  const args = calls[0];
  assert.equal(calls.length, 1);
  assert.equal(args[args.indexOf('-cq') + 1], '14'); assert.equal(args[args.indexOf('-b:v') + 1], '0');
  for (const flag of ['-maxrate','-bufsize','-level:v']) assert.equal(args.includes(flag), false);
  assert.match(events.find(event => event.type === 'transcode-info').encoder, /hardware decode \+ GPU scale \+ hardware encode/);
  const probe = await probeMedia(output, (await resolveFfprobe()).path, undefined, 'segment.ts');
  assert.equal(probe.info.width, 640); assert.equal(probe.info.height, 360); assert.equal(probe.info.fps, 60);
});

test("failed GPU decoding/filters retain hardware encoding and failed modes are skipped on later seeks", { timeout: 30000 }, async t => {
  const source = await fixture(t); if (!source) return;
  const { segments, calls, events, state } = service(t, source, (binary, args, options) => {
    const filter = args[args.indexOf("-vf") + 1];
    if (args.includes("-hwaccel") || /hwupload/.test(filter)) {
      const child = new EventEmitter(); child.stderr = new PassThrough(); child.kill = () => {};
      process.nextTick(() => { child.stderr.end("simulated unsupported decode/filter"); child.emit("close", 1); });
      return child;
    }
    return spawn(binary, args, options);
  });
  await segments.ensure(0);
  assert.equal(calls.length, 4);
  assert.match(events.find(event => event.type === "transcode-info").encoder, /CPU decode\/filters \+ hardware encode/);
  await segments.cancel(); state.playback.time = 3; segments.restart();
  const before = calls.length;
  await segments.ensure(1);
  assert.equal(calls.length - before, 1, "a filter failure does not blacklist NVENC or repeat on seek");
});

test("missing GPU HDR filters preserve hardware decode and encode around the CPU tone mapper", { timeout: 30000 }, async t => {
  const source = await fixture(t, true); if (!source) return;
  source.encoder = { ...source.encoder, capabilities: { ...source.encoder.capabilities, filters: new Set() } };
  const { segments, events, calls } = service(t, source);
  await segments.ensure(0);
  assert.match(events.find(event => event.type === "transcode-info").encoder, /hardware decode \+ CPU filters \+ hardware encode/);
  assert.equal(calls.length, 1);
});
