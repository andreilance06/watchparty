const HEIGHTS = [1080, 720, 480, 360];
const BITRATES = [8000000, 5000000, 3000000, 1500000, 750000];
const DEFAULTS = { 1080: 5000000, 720: 3000000, 480: 1500000, 360: 750000 };

function bitrateRange(info = {}) {
  const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;
  const estimate = positive(info.width, 1920) * positive(info.height, 1080) * positive(info.fps, 30) * 0.15;
  const max = Math.ceil(Math.max(25000, positive(info.bitrate, 0), estimate) / 1000) * 1000;
  return { min: Math.max(25000, Math.ceil(max * 0.05 / 1000) * 1000), max, step: 1000 };
}

function dimensions(info, height) {
  const width = Math.ceil(height * 16 / 9 / 2) * 2;
  const scale = Math.min(1, width / (info.width || width), height / (info.height || height));
  return { width: Math.max(2, Math.min(Math.floor((info.width || width) / 2) * 2, Math.round((info.width || width) * scale / 2) * 2)),
    height: Math.max(2, Math.min(Math.floor((info.height || height) / 2) * 2, Math.round((info.height || height) * scale / 2) * 2)) };
}

function qualityOptions(info = {}) {
  const heights = HEIGHTS.filter(height => height <= info.height);
  // A smaller source still needs a compatibility rendition, at its own size.
  if (!heights.length) heights.push(Math.min(360, info.height || 360));
  const { min, max } = bitrateRange(info);
  return heights.map(height => ({ quality: String(height), ...dimensions(info, height),
    bitrate: Math.max(min, Math.min(max, DEFAULTS[height] || 750000)) }));
}

function resolveQuality(info, quality, bitrate = "auto") {
  const range = bitrateRange(info);
  if (quality === "source" && bitrate === "source") {
    const width = Math.max(2, Math.floor((info.width || 1920) / 2) * 2);
    const height = Math.max(2, Math.floor((info.height || 1080) / 2) * 2);
    return { quality, width, height, bitrate, rateControl: "near-lossless", estimatedBitrate: range.max * 2,
      id: `${width}x${height}_source` };
  }
  if (typeof quality !== "string" || !["auto", ...qualityOptions(info).map(option => option.quality)].includes(quality) ||
      (bitrate !== "auto" && (!Number.isSafeInteger(bitrate) || bitrate < range.min || bitrate > range.max))) {
    throw new Error("Invalid resolution or bitrate limit.");
  }
  const options = qualityOptions(info);
  const option = quality === "auto" ? options.find(option => Number(option.quality) <= 720) || options[0] : options.find(option => option.quality === quality);
  const limit = bitrate === "auto" ? option.bitrate : bitrate;
  return { ...option, bitrate: limit, id: `${option.width}x${option.height}_${limit}` };
}

module.exports = { HEIGHTS, BITRATES, DEFAULTS, bitrateRange, qualityOptions, resolveQuality };
