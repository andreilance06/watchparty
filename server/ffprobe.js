const { run, names, discoverExternal } = require("./ffmpeg");

const inventories = new Map(), selections = new Map();
function inspectFfprobe(file) {
  if (!inventories.has(file)) inventories.set(file, (async () => {
    const [version, demuxers, decoders, protocols, json] = await Promise.all([
      ["-version"], ["-demuxers"], ["-decoders"], ["-protocols"], ["-v", "error", "-of", "json", "-show_program_version"]
    ].map(args => run(file, args)));
    if (!JSON.parse(json).program_version) throw new Error("ffprobe does not support JSON output.");
    return { path: file, version: version.split(/\r?\n/)[0], demuxers: names(demuxers), decoders: names(decoders),
      protocols: new Set(protocols.split("Output:")[0].split(/\r?\n/).map(line => line.trim()).filter(line => /^\w+$/.test(line))) };
  })());
  return inventories.get(file);
}
function usable(info) {
  return ["mov", "matroska", "mpegts", "ass"].every(name => info.demuxers.has(name)) &&
    ["h264", "aac"].every(name => info.decoders.has(name)) && ["file", "http"].every(name => info.protocols.has(name));
}
function featureScore(info) {
  const relevant = ["mov", "matroska", "mpegts", "avi", "ogg", "srt", "webvtt"].filter(name => info.demuxers.has(name)).length +
    ["h264", "hevc", "av1", "vp9", "aac", "ac3", "eac3", "dca", "opus", "ass", "mov_text"].filter(name => info.decoders.has(name)).length;
  return [relevant, info.demuxers.size + info.decoders.size + info.protocols.size];
}
async function selectFfprobe({ candidates = discoverExternal(process.env.FFPROBE_PATH || "", process.env.PATH || "", "ffprobe"),
  bundled = require("@derhuerst/ffprobe-static"), inspect = inspectFfprobe } = {}) {
  let selected, score;
  for (const result of await Promise.allSettled(candidates.map(file => inspect(file)))) {
    if (result.status !== "fulfilled" || !usable(result.value)) continue;
    const next = featureScore(result.value);
    const difference = score ? next.map((value, index) => value - score[index]).find(value => value !== 0) : 1;
    if (difference > 0) { selected = result.value; score = next; }
  }
  if (selected) return { ...selected, reason: `most capable external ffprobe (${score.join("/")})` };
  if (!bundled) throw new Error("No usable ffprobe installation was found. Install dependencies or set FFPROBE_PATH.");
  const fallback = await inspect(bundled);
  if (!usable(fallback)) throw new Error("Bundled ffprobe lacks required media inspection features. Set FFPROBE_PATH to a compatible executable.");
  return { ...fallback, reason: "bundled fallback; no usable external ffprobe" };
}
function resolveFfprobe() {
  const key = `${process.env.FFPROBE_PATH || ""}\0${process.env.PATH || ""}`;
  if (!selections.has(key)) selections.set(key, selectFfprobe());
  return selections.get(key);
}

module.exports = { inspectFfprobe, selectFfprobe, resolveFfprobe, featureScore };
