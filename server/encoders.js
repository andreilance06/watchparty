const { spawn } = require("child_process");

const CPU_ENCODER = {
  name: "libx264", label: "CPU fallback (libx264)", input: [],
  args: ["-preset", "veryfast", "-crf", "18"]
};

function testEncoder(ffmpegPath, name) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", "color=c=black:s=64x64:d=0.05", "-frames:v", "1",
      "-c:v", name, "-f", "null", "-"
    ], { windowsHide: true });
    let settled = false;
    const finish = (works) => { if (!settled) { settled = true; clearTimeout(timer); resolve(works); } };
    const timer = setTimeout(() => { child.kill(); finish(false); }, 5000);
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });
}

async function detectVideoEncoder(ffmpegPath) {
  if (process.env.WATCHPARTY_ENCODER) {
    return { name: process.env.WATCHPARTY_ENCODER, label: process.env.WATCHPARTY_ENCODER, input: [], args: [] };
  }
  const candidates = [
    {
      name: "h264_nvenc", label: "NVIDIA NVENC (h264_nvenc + CUDA decode)",
      input: ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"],
      args: ["-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", "18", "-b:v", "0", "-spatial_aq", "1", "-temporal_aq", "1"]
    },
    {
      name: "h264_qsv", label: "Intel Quick Sync (h264_qsv + QSV decode)",
      input: ["-hwaccel", "qsv", "-hwaccel_output_format", "qsv"],
      args: ["-preset", "slow", "-global_quality", "19"]
    },
    {
      name: "h264_amf", label: "AMD AMF (h264_amf + D3D11VA decode)",
      input: ["-hwaccel", "d3d11va"],
      args: ["-quality", "quality", "-rc", "cqp", "-qp_i", "18", "-qp_p", "20", "-qp_b", "22"]
    },
    {
      name: "h264_videotoolbox", label: "Apple VideoToolbox",
      input: ["-hwaccel", "videotoolbox"], args: ["-q:v", "80"]
    }
  ];
  for (const candidate of candidates) if (await testEncoder(ffmpegPath, candidate.name)) return candidate;
  return CPU_ENCODER;
}

function encoderAttempts(encoder) {
  if (encoder.name === "libx264") return [CPU_ENCODER];
  return [
    encoder,
    { ...encoder, label: `${encoder.name} hardware encode`, input: [] },
    CPU_ENCODER
  ];
}

module.exports = { CPU_ENCODER, testEncoder, detectVideoEncoder, encoderAttempts };
