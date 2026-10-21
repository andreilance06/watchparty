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
