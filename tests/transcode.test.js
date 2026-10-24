const test = require("node:test");
const assert = require("node:assert/strict");
const { transcodeAttempts } = require("../server/media/transcode");
const { CPU_ENCODER } = require("../server/encoders");

function hardware(name = "h264_nvenc", filters = ["scale_cuda", "libplacebo"]) {
  return { name, args: [], input: [], capabilities: { hwaccels: new Set(["cuda", "vulkan", "qsv", "d3d11va", "videotoolbox"]),
    filters: new Set(filters), options: { libplacebo: "inherit_device  <boolean>", vpp_qsv: "tonemap <int>" } } };
}
const info = { width: 3840, height: 2160, pixelFormat: "yuv420p10le", bitDepth: 10 };

test("GPU SDR plans retain hardware frames, scale without upscaling, and keep independent fallback IDs", () => {
  const attempts = transcodeAttempts(hardware(), info, null, 24);
  assert.equal(attempts[0].mode, "gpu"); assert.equal(attempts[0].pixelFormat, "cuda");
  assert.match(attempts[0].filter, /scale_cuda=w=1920:h=1080:format=nv12.*fps=24/);
  assert.deepEqual(attempts.map(a => a.mode), ["gpu", "hardware-decode", "software-decode-gpu", "hardware-encode", "cpu"]);
  assert.equal(new Set(attempts.map(a => a.id)).size, attempts.length);
  assert.match(transcodeAttempts(hardware(), { width: 320, height: 180 })[0].filter, /w=320:h=180/);
});

test("HDR plans tone map on GPU with interop and transfer fallbacks, never simply relabel HDR as SDR", () => {
  const plans = transcodeAttempts(hardware(), { ...info, hdr: true });
  assert.deepEqual(plans.slice(0, 3).map(a => a.mode), ["gpu-interop", "gpu-transfer", "hardware-decode"]);
  assert.match(plans[0].filter, /tonemapping=hable/);
  assert.match(plans[0].filter, /color_trc=bt709/);
  assert.match(plans[1].filter, /hwdownload,format=p010le,hwupload/);
  assert.match(plans[2].filter, /tonemap=tonemap=hable/);
  const fallback = transcodeAttempts(hardware("h264_nvenc", ["scale_cuda"]), { ...info, hdr: true });
  assert.equal(fallback[0].mode, "hardware-decode");
  assert.match(fallback[0].filter, /tonemap=/);
});

test("Intel, AMD, and Apple processing is gated by installed filters and HDR options", () => {
  for (const [name, filter] of [["h264_qsv", "vpp_qsv"], ["h264_amf", "vpp_amf"], ["h264_videotoolbox", "scale_vt"]]) {
    const candidate = hardware(name, [filter]);
    assert.equal(transcodeAttempts(candidate, info)[0].mode, "gpu");
    const hdr = transcodeAttempts(candidate, { ...info, hdr: true })[0];
    assert.equal(hdr.mode, "gpu"); assert.match(hdr.filter, /bt709/);
    if (name === "h264_qsv") {
      candidate.capabilities.options = {};
      assert.equal(transcodeAttempts(candidate, { ...info, hdr: true })[0].mode, "hardware-decode");
    }
    assert.equal(transcodeAttempts(hardware(name, []), info)[0].mode, "hardware-decode");
  }
  assert.equal(transcodeAttempts(CPU_ENCODER, info).length, 1);
  assert.deepEqual(transcodeAttempts({ name: "custom", args: [], input: [] }, info).map(a => a.mode), ["hardware-encode", "cpu"]);
});

test("12-bit metadata and explicit PQ/HLG color information are preserved for capability checks", () => {
  const { parseProbe } = require("../server/media/probe");
  const stream = { index: 0, codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p12le', width: 3840, height: 2160,
    avg_frame_rate: '24000/1001', color_space: 'bt2020nc', color_primaries: 'bt2020', color_transfer: 'smpte2084',
    side_data_list: [{ side_data_type: 'Mastering display metadata' }] };
  const parse = change => parseProbe({ format: { duration: '12' }, streams: [{ ...stream, ...change }] }).info;
  const pq = parse({});
  assert.equal(pq.bitDepth, 12); assert.equal(pq.hdr, true); assert.equal(pq.colorPrimaries, "bt2020");
  assert.equal(pq.colorTransfer, "smpte2084"); assert.equal(pq.hdrMetadataType, "smpteSt2086");
  assert.equal(parse({ color_transfer: 'arib-std-b67' }).colorTransfer, 'arib-std-b67');
  assert.equal(parse({ color_transfer: undefined }).hdr, false);
});
