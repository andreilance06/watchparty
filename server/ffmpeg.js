const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const inventories = new Map(), selections = new Map();
const names = output => new Set([...output.matchAll(/^\s*[A-Z.]{1,8}\s+([\w,]+)\s/gm)].flatMap(match => match[1].split(",")));
function run(file, args) {
  return new Promise((resolve, reject) => execFile(file, ["-hide_banner", ...args],
    { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(error); else resolve(`${stdout}\n${stderr}`);
    }));
}

function inspectFfmpeg(file) {
  if (!inventories.has(file)) inventories.set(file, (async () => {
    const [version, encoders, decoders, filters, formats, hwaccels] = await Promise.all(
      ["-version", "-encoders", "-decoders", "-filters", "-formats", "-hwaccels"].map(flag => run(file, [flag])));
    const inventory = { path: file, version: version.split(/\r?\n/)[0], encoders: names(encoders), decoders: names(decoders),
      filters: names(filters), formats: names(formats), hwaccels: new Set(hwaccels.split(/\r?\n/).map(line => line.trim()).filter(line => /^\w+$/.test(line))), options: {} };
    await Promise.all(["vpp_qsv", "vpp_amf", "scale_vt", "libplacebo"].filter(name => inventory.filters.has(name)).map(async name => {
      inventory.options[name] = await run(file, ["-h", `filter=${name}`]).catch(() => "");
    }));
    return inventory;
  })());
  return inventories.get(file);
}

function usable(info) {
  return ["libx264", "aac", "ass"].every(name => info.encoders.has(name)) &&
    ["scale", "zscale", "tonemap", "format", "fps"].every(name => info.filters.has(name)) &&
    ["matroska", "mov", "mpegts", "hls", "ass"].every(name => info.formats.has(name));
}

function featureScore(info) {
  const has = (encoder, accel, filter) => info.encoders.has(encoder) && info.hwaccels.has(accel) && info.filters.has(filter);
  const sdr = Number(has("h264_nvenc", "cuda", "scale_cuda")) + Number(has("h264_qsv", "qsv", "vpp_qsv")) +
    Number(has("h264_amf", "d3d11va", "vpp_amf")) + Number(has("h264_videotoolbox", "videotoolbox", "scale_vt"));
  const hdr = Number(has("h264_nvenc", "cuda", "libplacebo") && info.hwaccels.has("vulkan")) +
    Number(has("h264_qsv", "qsv", "vpp_qsv") && /\btonemap\s/.test(info.options.vpp_qsv || "")) +
    Number(has("h264_amf", "d3d11va", "vpp_amf")) + Number(has("h264_videotoolbox", "videotoolbox", "scale_vt"));
  return [hdr, sdr, info.hwaccels.size + [...info.filters].filter(name => /cuda|qsv|amf|_vt|vulkan|opencl|vaapi|d3d11/.test(name)).length,
    info.encoders.size + info.decoders.size + info.filters.size];
}

function discoverExternal(provided = process.env.FFMPEG_PATH, pathValue = process.env.PATH || "", baseName = "ffmpeg") {
  const candidates = [];
  const add = file => {
    try {
      const resolved = fs.realpathSync(file);
      if (fs.statSync(resolved).isFile() && !candidates.some(candidate => process.platform === "win32" ? candidate.toLowerCase() === resolved.toLowerCase() : candidate === resolved)) candidates.push(resolved);
    } catch { /* Unavailable candidates do not prevent using another installation. */ }
  };
  const directories = pathValue.split(path.delimiter).filter(Boolean).map(directory => directory.replace(/^"|"$/g, ""));
  if (provided) {
    add(provided);
    if (!path.isAbsolute(provided)) for (const directory of directories) add(path.join(directory, provided));
  }
  for (const directory of directories) add(path.join(directory, baseName + (process.platform === "win32" ? ".exe" : "")));
  return candidates;
}

async function selectFfmpeg({ candidates = discoverExternal(), bundled = require("ffmpeg-static"), inspect = inspectFfmpeg } = {}) {
  const results = await Promise.allSettled(candidates.map(file => inspect(file)));
  let selected, score;
  for (const result of results) {
    if (result.status !== "fulfilled" || !usable(result.value)) continue;
    const next = featureScore(result.value);
    const difference = score ? next.map((value, index) => value - score[index]).find(value => value !== 0) : 1;
    if (difference > 0) { selected = result.value; score = next; }
  }
  if (selected) return { ...selected, reason: `most capable external FFmpeg (${score.join("/")})` };
  if (!bundled) throw new Error("No usable FFmpeg installation was found.");
  const fallback = await inspect(bundled);
  if (!usable(fallback)) throw new Error("Bundled FFmpeg lacks required playback or caption features.");
  return { ...fallback, reason: "bundled fallback; no usable external FFmpeg" };
}

function resolveFfmpeg() {
  const key = `${process.env.FFMPEG_PATH || ""}\0${process.env.PATH || ""}`;
  if (!selections.has(key)) selections.set(key, selectFfmpeg());
  return selections.get(key);
}

module.exports = { inspectFfmpeg, discoverExternal, selectFfmpeg, resolveFfmpeg, featureScore, run, names };
