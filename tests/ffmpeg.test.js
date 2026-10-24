const test = require("node:test");
const assert = require("node:assert/strict");
const { selectFfmpeg, featureScore, discoverExternal, inspectFfmpeg } = require("../server/ffmpeg");

function inventory(path, extra = {}) {
  return { path, version: path, encoders: new Set(["libx264", "aac", "ass"]), decoders: new Set(["h264"]),
    filters: new Set(["scale", "zscale", "tonemap", "format", "fps"]),
    formats: new Set(["matroska", "mov", "mpegts", "hls", "ass"]), hwaccels: new Set(), options: {}, ...extra };
}

test("FFmpeg selection compares relevant GPU features before total feature count and preserves tie order", async () => {
  const large = inventory("large", { decoders: new Set(Array.from({ length: 100 }, (_, i) => `codec${i}`)) });
  const gpu = inventory("gpu");
  gpu.encoders.add("h264_nvenc"); gpu.hwaccels.add("cuda"); gpu.filters.add("scale_cuda");
  const inspect = async path => ({ large, gpu, provided: inventory("provided"), path: inventory("path") })[path];
  assert.equal((await selectFfmpeg({ candidates: ["large", "gpu"], bundled: null, inspect })).path, "gpu");
  assert.equal((await selectFfmpeg({ candidates: ["provided", "path"], bundled: null, inspect })).path, "provided");
  gpu.hwaccels.add("vulkan"); gpu.filters.add("libplacebo");
  assert.equal(featureScore(gpu)[0], 1);
});

test("unusable and failed FFmpeg candidates fall back to the bundled binary", async () => {
  const broken = inventory("broken"); broken.encoders.delete("ass");
  const inspect = async path => {
    if (path === "missing" || path === "timeout") throw Object.assign(new Error(path), { code: path === "timeout" ? "ETIMEDOUT" : "ENOENT" });
    return path === "broken" ? broken : inventory(path);
  };
  const selected = await selectFfmpeg({ candidates: ["missing", "timeout", "broken"], bundled: "bundled", inspect });
  assert.equal(selected.path, "bundled");
  assert.match(selected.reason, /fallback/);
  await assert.rejects(selectFfmpeg({ candidates: ["missing"], bundled: null, inspect }), /No usable FFmpeg/);
  await assert.rejects(selectFfmpeg({ candidates: [], bundled: "broken", inspect }), /required playback or caption/);
});

test("discovery deduplicates provided and PATH binaries without invoking a shell", () => {
  const path = require("node:path");
  const binary = require("ffmpeg-static");
  if (!binary) return;
  const directory = path.dirname(binary);
  const result = discoverExternal(binary, [directory, directory].join(path.delimiter));
  assert.equal(result.length, 1);
});

test("explicit application FFmpeg overrides bypass executable discovery", async t => {
  const { createApplication } = require("../server/application");
  const { CPU_ENCODER } = require("../server/encoders");
  const app = createApplication({ config: { port: 0, ffmpegPath: "explicit-test-binary" }, encoderPromise: Promise.resolve(CPU_ENCODER) });
  t.after(() => app.close());
  await app.listen();
  assert.equal(app.config.ffmpegPath, "explicit-test-binary");
});

test("installed FFmpeg inventory includes both old and new table layouts", async t => {
  const binary = require("ffmpeg-static"); if (!binary) return t.skip("FFmpeg unavailable");
  const info = await inspectFfmpeg(binary);
  assert.ok(info.encoders.has("libx264")); assert.ok(info.filters.has("scale"));
  assert.ok(info.formats.has("mov")); assert.ok(info.formats.has("matroska"));
  assert.ok(info.decoders.has("hevc"));
});
