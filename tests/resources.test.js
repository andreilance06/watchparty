const test = require("node:test");
const assert = require("node:assert/strict");
const { createConfig } = require("../server/config");

test("small containers select bounded defaults without changing standard deployments", t => {
  for (const key of ["WATCHPARTY_LOW_MEMORY", "WATCHPARTY_MAX_ENCODERS", "WATCHPARTY_FFMPEG_THREADS"]) {
    const saved = process.env[key];
    delete process.env[key];
    t.after(() => { if (saved === undefined) delete process.env[key]; else process.env[key] = saved; });
  }
  t.mock.method(process, "constrainedMemory", () => 512 * 1024 * 1024);
  const small = createConfig();
  assert.equal(small.lowMemory, true);
  assert.equal(small.maxEncoders, 1);
  assert.equal(small.ffmpegThreads, 1);
  assert.equal(small.sourceCacheBytes, 4 * 1024 * 1024);
  assert.equal(small.sourceMaxReads, 2);
  t.mock.method(process, "constrainedMemory", () => 4 * 1024 * 1024 * 1024);
  const standard = createConfig();
  assert.equal(standard.lowMemory, false);
  assert.equal(standard.ffmpegThreads, 0);
  assert.equal(standard.maxEncoders, 2);
  process.env.WATCHPARTY_LOW_MEMORY = "1";
  assert.equal(createConfig().lowMemory, true);
  process.env.WATCHPARTY_FFMPEG_THREADS = "2";
  assert.equal(createConfig().ffmpegThreads, 2);
  process.env.WATCHPARTY_FFMPEG_THREADS = "-1";
  assert.throws(() => createConfig(), /ffmpegThreads/);
  delete process.env.WATCHPARTY_FFMPEG_THREADS;
  process.env.WATCHPARTY_LOW_MEMORY = "maybe";
  assert.throws(() => createConfig(), /WATCHPARTY_LOW_MEMORY/);
});
