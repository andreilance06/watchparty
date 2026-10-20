import { MoviPlayer } from "../../vendor/movi-player.js";

const audioCodecs = { aac: "mp4a.40.2", mp3: "mp3", opus: "opus", vorbis: "vorbis", flac: "flac" };

export async function choosePlayback(info) {
  if (!info) return "compatibility";
  if (info.videoCodec === "h264" && (info.bitDepth > 8 || /(?:444|422)/.test(info.pixelFormat || ""))) return "compatibility";
  const native = document.createElement("video");
  const nativeVideo = info.bitDepth <= 8 && (
    (info.mime === "video/mp4" && info.videoCodec === "h264") ||
    (info.mime === "video/webm" && ["vp8", "vp9", "av1"].includes(info.videoCodec)));
  const nativeAudio = !info.hasAudio || (info.mime === "video/mp4" ? ["aac", "mp3"].includes(info.audioCodec) : ["opus", "vorbis"].includes(info.audioCodec));
  if (nativeVideo && nativeAudio && native.canPlayType?.(info.mime)) return "native";
  if (!globalThis.isSecureContext || !globalThis.VideoDecoder || !globalThis.AudioDecoder) return "compatibility";
  // Do not start a second demuxer or reread the file just to assess it: the
  // server has already supplied the stream metadata needed for this query.
  try {
    const assessment = MoviPlayer.assessPlayback({ codec: info.videoCodec, width: info.width, height: info.height, fps: info.fps || 30 });
    const result = await Promise.race([assessment, new Promise((resolve) => setTimeout(() => resolve(null), 500))]);
    if (!result?.playable || !result.smooth) return "compatibility";
    if (info.hasAudio) {
      const codec = audioCodecs[info.audioCodec];
      // Unusual audio uses the server path rather than risking a silent picture.
      if (!codec) return "compatibility";
      const audio = await AudioDecoder.isConfigSupported({ codec, sampleRate: info.sampleRate || 48000, numberOfChannels: info.channels || 2 });
      if (!audio.supported) return "compatibility";
    }
    return "wasm";
  } catch { return "compatibility"; }
}
