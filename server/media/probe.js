const { execFile } = require("node:child_process");
const path = require("node:path");

const numeric = value => value !== undefined && value !== null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : 0;
function frameRate(value) {
  const [numerator, denominator = "1"] = String(value || "").split("/");
  return numeric(denominator) > 0 ? numeric(numerator) / numeric(denominator) : 0;
}
function parseProbe(data, fileName = "", sourcePath = fileName, { durationFallback = 0 } = {}) {
  if (!data || !Array.isArray(data.streams)) throw new Error("ffprobe returned invalid stream metadata.");
  const video = data.streams.find(stream => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  if (!video) throw new Error("The selected file has no video stream.");
  const audio = data.streams.find(stream => stream.codec_type === "audio");
  const format = data.format || {};
  const duration = numeric(format.duration) || Math.max(0, ...data.streams.map(stream => numeric(stream.duration))) || durationFallback;
  if (!(duration > 0)) throw new Error("Could not determine the video duration.");
  const mime = ({ ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".3gp": "video/3gpp", ".3g2": "video/3gpp2", ".webm": "video/webm",
    ".ogv": "video/ogg", ".ogg": "video/ogg", ".ogm": "video/ogg", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".ts": "video/mp2t" })[path.extname(fileName).toLowerCase()] || "application/octet-stream";
  const pixelFormat = video.pix_fmt || "";
  const depth = numeric(video.bits_per_raw_sample) || (/p0?(10|12|16)|(?:p|gbrp|gray)(10|12|16)(?:le|be)/.exec(pixelFormat)?.slice(1).find(Boolean));
  const sideData = video.side_data_list || [];
  const subtitles = data.streams.filter(stream => stream.codec_type === "subtitle" &&
    ["ass", "ssa", "subrip", "srt", "webvtt", "mov_text", "text"].includes(stream.codec_name)).slice(0, 8).map((stream, index) => {
    const title = stream.tags?.title?.trim() || stream.tags?.handler_name?.trim();
    const streamId = /^(?:0x[\da-f]+|\d+)$/i.test(String(stream.id)) ? Number(stream.id) : undefined;
    return { input: sourcePath, map: `0:${stream.index}`, ...(Number.isSafeInteger(streamId) ? { streamId } : {}),
      codec: stream.codec_name, lang: stream.tags?.language || "und", title, label: title || `Captions ${index + 1}`,
      default: Boolean(stream.disposition?.default), forced: Boolean(stream.disposition?.forced) };
  });
  const fonts = data.streams.filter(stream => stream.codec_type === "attachment" && ["ttf", "otf"].includes(stream.codec_name))
    .slice(0, 16).map(stream => ({ map: String(stream.index), extension: stream.codec_name }));
  return { duration, start: numeric(format.start_time ?? video.start_time), subtitles, fonts, info: {
    mime, bitrate: numeric(format.bit_rate), videoCodec: video.codec_name || "", audioCodec: audio?.codec_name || "", hasAudio: Boolean(audio),
    sampleRate: numeric(audio?.sample_rate) || 48000, channels: numeric(audio?.channels) || (audio?.channel_layout === "mono" ? 1 : 2),
    pixelFormat, width: numeric(video.width), height: numeric(video.height), fps: frameRate(video.avg_frame_rate) || frameRate(video.r_frame_rate),
    bitDepth: numeric(depth) || 8, colorTransfer: video.color_transfer || "", colorPrimaries: video.color_primaries || "", colorSpace: video.color_space || "",
    hdrMetadataType: sideData.some(side => /Mastering display metadata/i.test(side.side_data_type)) ? "smpteSt2086" : "",
    dynamicHdr: sideData.some(side => /DOVI|HDR10\+|SMPTE2094/i.test(side.side_data_type)),
    hdr: ["smpte2084", "arib-std-b67"].includes(video.color_transfer)
  } };
}
function probeMedia(sourcePath, ffprobePath, signal, fileName, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(ffprobePath, ["-v", "error", "-show_format", "-show_streams", "-of", "json",
      ...(sourcePath.startsWith("http:") ? ["-rw_timeout", "30000000"] : []), ...(options.inputArgs || []), "-i", sourcePath],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024, signal, timeout: 30000 }, (error, stdout) => {
      if (signal?.aborted) return reject(signal.reason || error);
      if (error) return reject(new Error(`ffprobe could not inspect the selected video: ${error.message}`));
      try { resolve(parseProbe(JSON.parse(stdout), fileName, sourcePath, options)); }
      catch (error) { reject(new Error(`Invalid ffprobe metadata: ${error.message}`)); }
    });
  });
}

module.exports = { parseProbe, frameRate, probeMedia };
