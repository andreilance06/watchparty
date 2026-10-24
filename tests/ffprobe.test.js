const test = require("node:test");
const assert = require("node:assert/strict");
const { selectFfprobe, inspectFfprobe } = require("../server/ffprobe");
const { parseProbe, frameRate, probeMedia } = require("../server/media/probe");

function inventory(path) { return { path, version: path, demuxers: new Set(["mov", "matroska", "mpegts", "ass"]),
  decoders: new Set(["h264", "aac"]), protocols: new Set(["http", "file"]) }; }
test("ffprobe selection compares features, preserves tie precedence, and bundles its own fallback", async () => {
  const basic = inventory("provided"), rich = inventory("path"), bundled = inventory("bundled"); rich.decoders.add("hevc");
  const inspect = async path => { if (path === "bad") throw Error("timeout or invalid executable"); return { provided: basic, path: rich, bundled }[path]; };
  assert.equal((await selectFfprobe({ candidates: ["provided", "path"], bundled: null, inspect })).path, "path");
  rich.decoders.delete("hevc");
  assert.equal((await selectFfprobe({ candidates: ["provided", "path"], bundled: null, inspect })).path, "provided");
  assert.equal((await selectFfprobe({ candidates: ["bad"], bundled: "bundled", inspect })).path, "bundled");
  await assert.rejects(selectFfprobe({ candidates: ["bad"], bundled: null, inspect }), /FFPROBE_PATH/);
  basic.protocols.delete("http");
  assert.equal((await selectFfprobe({ candidates: ["provided"], bundled: "bundled", inspect })).path, "bundled");
});
test("bundled ffprobe supports JSON and required inspection capabilities", async () => {
  const info = await inspectFfprobe(require("@derhuerst/ffprobe-static"));
  assert.match(info.version, /^ffprobe version/); assert.ok(info.demuxers.has("mov")); assert.ok(info.protocols.has("http"));
});
test("JSON parsing preserves rational frame rates, explicit depth, audio, HDR side data, and attachments", () => {
  const parsed = parseProbe({ format: { duration: "120.5", start_time: "-0.021", bit_rate: "9000000" }, streams: [
    { codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } },
    { codec_type: "video", codec_name: "hevc", width: 3840, height: 2160, pix_fmt: "yuv420p10le", avg_frame_rate: "24000/1001",
      color_transfer: "smpte2084", color_primaries: "bt2020", color_space: "bt2020nc", bits_per_raw_sample: "10", side_data_list: [{ side_data_type: "Mastering display metadata" }] },
    { codec_type: "audio", codec_name: "eac3", sample_rate: "48000", channels: 6 },
    { index: 3, codec_type: "attachment", codec_name: "ttf" }
  ] }, "movie.mkv");
  assert.equal(parsed.duration, 120.5); assert.equal(parsed.start, -0.021); assert.equal(parsed.info.fps, 24000 / 1001);
  assert.equal(parsed.info.hasAudio, true); assert.equal(parsed.info.channels, 6); assert.equal(parsed.info.hdr, true);
  assert.equal(parsed.info.bitDepth, 10); assert.equal(parsed.info.videoCodec, "hevc");
  assert.equal(parsed.info.hdrMetadataType, "smpteSt2086"); assert.deepEqual(parsed.fonts, [{ map: "3", extension: "ttf" }]);
  assert.equal(frameRate("0/0"), 0); assert.equal(frameRate("30000/1001"), 30000 / 1001);
});
test("silent files, stream durations, validated timeline fallback, and malformed metadata are handled explicitly", () => {
  const stream = { codec_type: "video", codec_name: "h264", avg_frame_rate: "0/0", r_frame_rate: "25/1", duration: "12" };
  const parsed = parseProbe({ streams: [stream] });
  assert.equal(parsed.duration, 12); assert.equal(parsed.info.fps, 25); assert.equal(parsed.info.hasAudio, false);
  assert.equal(parseProbe({ streams: [{ ...stream, duration: undefined }] }, "", "", { durationFallback: 55 }).duration, 55);
  assert.throws(() => parseProbe({ streams: [] }), /no video/);
  assert.throws(() => parseProbe({}), /invalid stream/);
  assert.throws(() => parseProbe({ streams: [{ ...stream, duration: "N/A" }] }), /duration/);
});
test("ffprobe cancellation never falls back to another scanning process", async () => {
  const controller = new AbortController(); controller.abort(new Error("preparation cancelled"));
  await assert.rejects(probeMedia("unused.mkv", require("@derhuerst/ffprobe-static"), controller.signal, "unused.mkv"), /preparation cancelled/);
});
