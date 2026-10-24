import { MoviPlayer } from "../../vendor/movi-player.js";

const audioCodecs = { aac: "mp4a.40.2", mp3: "mp3", opus: "opus", vorbis: "vorbis", flac: "flac" };

export function hdrDisplaySupported() {
  try {
    return Boolean(globalThis.matchMedia?.("(video-dynamic-range: high)").matches || globalThis.matchMedia?.("(dynamic-range: high)").matches);
  } catch { return false; }
}

async function hdrPlayback(info) {
  // HDR presentation by the WASM/canvas renderer is not established. Only
  // native playback is eligible, and only with explicit source color metadata.
  const transferFunction = { smpte2084: "pq", "arib-std-b67": "hlg" }[info.colorTransfer];
  const colorGamut = { bt2020: "rec2020", smpte432: "p3" }[info.colorPrimaries];
  const api = globalThis.navigator?.mediaCapabilities;
  if (!hdrDisplaySupported() || !api?.decodingInfo || !transferFunction || !colorGamut || !info.videoCodecString ||
    info.dynamicHdr || !["video/mp4", "video/webm"].includes(info.mime)) return "compatibility";
  const contentType = `${info.mime}; codecs="${info.videoCodecString}"`;
  if (!document.createElement("video").canPlayType?.(contentType)) return "compatibility";
  if (info.hasAudio && !audioCodecs[info.audioCodec]) return "compatibility";
  let timer;
  try {
    const configuration = { type: "file", video: { contentType, width: info.width, height: info.height,
      bitrate: info.bitrate || 8000000, framerate: info.fps || 30, transferFunction, colorGamut } };
    if (info.hdrMetadataType) configuration.video.hdrMetadataType = info.hdrMetadataType;
    if (info.hasAudio) configuration.audio = { contentType: `${info.mime.replace("video/", "audio/")}; codecs="${audioCodecs[info.audioCodec]}"`,
      channels: String(info.channels || 2), samplerate: info.sampleRate || 48000, bitrate: 192000 };
    const result = await Promise.race([Promise.resolve().then(() => api.decodingInfo(configuration)),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 500); })]);
    // Check the returned configuration too: older implementations can silently
    // ignore HDR dictionary fields and answer only the basic codec question.
    const checked = result?.configuration?.video;
    return result?.supported && result.smooth && checked?.transferFunction === transferFunction && checked?.colorGamut === colorGamut &&
      (!info.hdrMetadataType || checked.hdrMetadataType === info.hdrMetadataType) &&
      hdrDisplaySupported() ? "native" : "compatibility";
  } catch { return "compatibility"; }
  finally { clearTimeout(timer); }
}

export async function choosePlayback(info) {
  if (!info) return "compatibility";
  if (info.hdr) return hdrPlayback(info);
  if (info.videoCodec === "h264" && (info.bitDepth > 8 || /(?:444|422)/.test(info.pixelFormat || ""))) return "compatibility";
  const native = document.createElement("video");
  const nativeVideo = info.bitDepth <= 8 && (
    (info.mime === "video/mp4" && info.videoCodec === "h264") ||
    (info.mime === "video/webm" && ["vp8", "vp9", "av1"].includes(info.videoCodec)));
  const nativeAudio = !info.hasAudio || (info.mime === "video/mp4" ? ["aac", "mp3"].includes(info.audioCodec) : ["opus", "vorbis"].includes(info.audioCodec));
  if (nativeVideo && nativeAudio && native.canPlayType?.(info.mime)) return "native";
  // Movi's WASM demuxer scans fragmented MP4s sequentially. The server can
  // use their seek index without pulling the recording through the browser.
  if (info.container?.family === "iso-bmff" && info.container.fragmented) return "compatibility";
  if (!globalThis.isSecureContext || !globalThis.VideoDecoder) return "compatibility";
  const codec = audioCodecs[info.audioCodec];
  // Silent sources do not need an audio decoder. Unusual audio stays on the
  // server path rather than risking a silent picture or expensive software audio.
  if (info.hasAudio && (!globalThis.AudioDecoder || !codec)) return "compatibility";
  // Do not start a second demuxer or reread the file just to assess it: the
  // server has already supplied the stream metadata needed for this query.
  let timer;
  try {
    const assessment = Promise.all([
      Promise.resolve().then(() => MoviPlayer.assessPlayback({ codec: info.videoCodec, width: info.width, height: info.height, fps: info.fps || 30 })),
      Promise.resolve().then(() => info.hasAudio ? AudioDecoder.isConfigSupported({ codec, sampleRate: info.sampleRate || 48000, numberOfChannels: info.channels || 2 }) : { supported: true })
    ]);
    // One deadline covers both checks; a hung audio query must not hold up the
    // source switch after the video query has already succeeded.
    const result = await Promise.race([assessment, new Promise((resolve) => { timer = setTimeout(() => resolve(null), 500); })]);
    if (!result) return "compatibility";
    const [video, audio] = result;
    const browserDecoder = ["hardware", "software"].includes(video?.video?.decoder);
    return video?.playable && video.smooth && browserDecoder && audio?.supported ? "wasm" : "compatibility";
  } catch { return "compatibility"; }
  finally { clearTimeout(timer); }
}
