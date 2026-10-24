const fs = require("node:fs");
const path = require("node:path");

// Use whole output frames, including at fractional frame rates.
function segmentSchedule(state, targetSeconds = 2) {
  const fps = Math.min(30, state.mediaInfo?.fps || 30);
  const frames = Math.max(1, Math.round(targetSeconds * fps));
  const seconds = frames / fps;
  return { fps, frames, seconds, count: Math.ceil(state.mediaDuration / seconds) };
}

function streamDirectory(state) {
  return path.join(state.hlsDirectory, `run_${state.streamGeneration || 0}`);
}

function writePlaylists(state, targetSeconds) {
  const { seconds, count } = segmentSchedule(state, targetSeconds);
  const query = `v=${state.mediaVersion}&g=${state.roomState?.streamGeneration ?? state.streamGeneration ?? 0}` +
    (state.rendition ? `&r=${state.rendition.id}&rg=${state.streamGeneration || 0}` : "");
  const video = ["#EXTM3U", "#EXT-X-VERSION:6", `#EXT-X-TARGETDURATION:${Math.ceil(seconds)}`,
    "#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-INDEPENDENT-SEGMENTS"];
  for (let index = 0; index < count; index++) {
    // The prefix is only for native bootstrap. The playable suffix is one run.
    if (index && index === state.compatibilityStartIndex) video.push("#EXT-X-DISCONTINUITY");
    video.push(`#EXTINF:${Math.min(seconds, state.mediaDuration - index * seconds).toFixed(9)},`,
      `segment_${String(index).padStart(6, "0")}.ts?${query}`);
  }
  video.push("#EXT-X-ENDLIST", "");
  fs.writeFileSync(path.join(state.hlsDirectory, "video.m3u8"), video.join("\n"));
  const codec = `avc1.640029${state.mediaInfo?.hasAudio === false ? "" : ",mp4a.40.2"}`;
  const bandwidth = state.rendition ? Math.ceil((state.rendition.bitrate + (state.mediaInfo?.hasAudio === false ? 0 : 192000)) * 11 / 10) : 8500000;
  const resolution = state.rendition ? `,RESOLUTION=${state.rendition.width}x${state.rendition.height}` : "";
  fs.writeFileSync(path.join(state.hlsDirectory, "master.m3u8"),
    `#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},CODECS="${codec}"${resolution}\nvideo.m3u8?${query}\n`);
}

module.exports = { writePlaylists, segmentSchedule, streamDirectory };
