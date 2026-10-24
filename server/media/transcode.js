const { CPU_ENCODER } = require("../encoders");

function compatibilityFilter(info = {}, profile) {
  const filters = [];
  if (info.hdr) filters.push("zscale=t=linear:npl=100", "format=gbrpf32le", "zscale=p=bt709", "tonemap=tonemap=hable:desat=0", "zscale=t=bt709:m=bt709:r=tv");
  filters.push(profile ? `scale=${profile.width}:${profile.height}` :
    "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", "format=yuv420p");
  return filters.join(",");
}

const backends = {
  h264_nvenc: { accel: "cuda", frame: "cuda", upload: "hwupload_cuda", filter: "scale_cuda" },
  h264_qsv: { accel: "qsv", frame: "qsv", upload: "hwupload=extra_hw_frames=32", filter: "vpp_qsv" },
  h264_amf: { accel: "d3d11va", frame: "d3d11", output: "amf", upload: "hwupload", filter: "vpp_amf" },
  h264_videotoolbox: { accel: "videotoolbox", frame: "videotoolbox_vld", upload: "hwupload", filter: "scale_vt" }
};

function transcodeAttempts(encoder, info = {}, profile, fps = 30) {
  const attempts = [], backend = backends[encoder.name], caps = encoder.capabilities;
  const software = `${compatibilityFilter(info, profile)},fps=${fps}`;
  const target = profile || (info.width > 0 && info.height > 0 ? (() => {
    const ratio = Math.min(1, 1920 / info.width, 1080 / info.height);
    return { width: Math.max(2, Math.floor(info.width * ratio / 2) * 2), height: Math.max(2, Math.floor(info.height * ratio / 2) * 2) };
  })() : null);
  const add = (mode, input, filter, pixelFormat, stages, init = []) => {
    const candidate = { ...encoder, input, init, filter, pixelFormat, mode, stages,
      label: `${encoder.name}: ${stages}` };
    candidate.id = JSON.stringify([encoder.name, mode, input, init, filter, pixelFormat, encoder.args]);
    if (!attempts.some(attempt => attempt.id === candidate.id)) attempts.push(candidate);
  };
  if (encoder.name !== "libx264" && backend && caps?.hwaccels.has(backend.accel)) {
    const input = ["-hwaccel", backend.accel, "-hwaccel_output_format", backend.frame];
    let gpuFilter;
    if (target && caps.filters.has(backend.filter)) {
      const size = `w=${target.width}:h=${target.height}`;
      if (encoder.name === "h264_nvenc" && !info.hdr) gpuFilter = `scale_cuda=${size}:format=nv12:passthrough=0`;
      if (encoder.name === "h264_qsv" && (!info.hdr || /\btonemap\s/.test(caps.options?.vpp_qsv || ""))) {
        gpuFilter = `vpp_qsv=${size}:format=nv12${info.hdr ? ":tonemap=1:out_color_matrix=bt709:out_color_primaries=bt709:out_color_transfer=bt709" : ""}`;
      }
      if (encoder.name === "h264_amf") gpuFilter = `vpp_amf=${size}:format=nv12${info.hdr ? ":color_profile=bt709:out_trc=bt709" : ""}`;
      if (encoder.name === "h264_videotoolbox") gpuFilter = `scale_vt=${size}${info.hdr ? ":color_matrix=bt709:color_primaries=bt709:color_transfer=bt709" : ""}`;
    }
    if (gpuFilter) add("gpu", input, `${gpuFilter},fps=${fps}`, backend.output || backend.frame, `hardware decode + GPU ${info.hdr ? "tone map/scale" : "scale"} + hardware encode`);

    if (encoder.name === "h264_nvenc" && info.hdr && target && caps.filters.has("libplacebo") && caps.hwaccels.has("vulkan")) {
      const placebo = `libplacebo=w=${target.width}:h=${target.height}:format=nv12:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:tonemapping=hable`;
      // Only newer builds expose this interop option. Driver support is still
      // validated by the real encode; transfers remain an independent attempt.
      if (/\binherit_device\s/.test(caps.options?.libplacebo || "")) {
        add("gpu-interop", [...input, "-hwaccel_device", "cu"],
          `hwupload=derive_device=vulkan,${placebo}:inherit_device=1,hwupload=derive_device=cuda,fps=${fps}`, "cuda",
          "hardware decode + GPU tone map/scale + hardware encode (GPU interop)",
          ["-init_hw_device", "vulkan=vk:0,disable_multiplane=1", "-init_hw_device", "cuda=cu@vk", "-filter_hw_device", "cu"]);
      }
      const sourceFormat = info.pixelFormat?.startsWith("yuv420p") || !info.pixelFormat ? (info.bitDepth > 8 ? "p010le" : "nv12") : null;
      if (sourceFormat) add("gpu-transfer", input,
        `hwdownload,format=${sourceFormat},hwupload,${placebo},hwdownload,format=nv12,hwupload_cuda,fps=${fps}`, "cuda",
        "hardware decode + GPU tone map/scale + hardware encode (frame transfers)",
        ["-init_hw_device", "vulkan=vk:0", "-filter_hw_device", "vk"]);
    }

    // Automatic hwaccel normally transfers decoded frames to system memory.
    // Omitting hwaccel_output_format lets the CPU filter graph consume them.
    // Decode failure and filter failure are separate from encoder failure.
    add("hardware-decode", ["-hwaccel", backend.accel], software, "yuv420p", "hardware decode + CPU filters + hardware encode");

    if (encoder.name === "h264_nvenc" && info.hdr && target && caps.filters.has("libplacebo") && caps.hwaccels.has("vulkan")) {
      add("software-decode-gpu", [],
        `format=p010le,hwupload,libplacebo=w=${target.width}:h=${target.height}:format=nv12:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:tonemapping=hable,hwdownload,format=nv12,hwupload_cuda,fps=${fps}`, "cuda",
        "CPU decode + GPU tone map/scale + hardware encode (frame transfers)",
        ["-init_hw_device", "vulkan=vk:0", "-filter_hw_device", "vk"]);
    }

    if (gpuFilter && !info.hdr) {
      const init = backend.accel === "cuda" ? [] : ["-init_hw_device", `${backend.accel === "d3d11va" ? "d3d11va" : backend.accel}=processing`, "-filter_hw_device", "processing"];
      add("software-decode-gpu", [], `format=nv12,${backend.upload},${gpuFilter},fps=${fps}`, backend.output || backend.frame,
        "CPU decode + GPU scale + hardware encode", init);
    }
  }
  if (encoder.name !== "libx264") add("hardware-encode", [], software, "yuv420p", "CPU decode/filters + hardware encode");
  const cpu = { ...CPU_ENCODER, mode: "cpu", init: [], filter: software, pixelFormat: "yuv420p", stages: "CPU decode/filters/encode" };
  cpu.id = JSON.stringify([cpu.name, cpu.filter, cpu.args]);
  attempts.push(cpu);
  return attempts;
}

module.exports = { compatibilityFilter, transcodeAttempts };
