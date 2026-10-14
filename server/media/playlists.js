const fs = require("fs");
const path = require("path");

function writePlaylists(state, SEGMENT_SECONDS) {
  const count = Math.ceil(state.mediaDuration / SEGMENT_SECONDS);
  const video = [
    "#EXTM3U", "#EXT-X-VERSION:3", `#EXT-X-TARGETDURATION:${SEGMENT_SECONDS}`,
    "#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-INDEPENDENT-SEGMENTS"
  ];
  for (let index = 0; index < count; index += 1) {
    const duration = Math.min(SEGMENT_SECONDS, state.mediaDuration - index * SEGMENT_SECONDS);
    if (index) video.push("#EXT-X-DISCONTINUITY");
    video.push(`#EXTINF:${duration.toFixed(3)},`, `segment_${String(index).padStart(6, "0")}.ts?v=${state.mediaVersion}`);
  }
  video.push("#EXT-X-ENDLIST", "");
  fs.writeFileSync(path.join(state.hlsDirectory, "video.m3u8"), video.join("\n"));

  const master = ["#EXTM3U", "#EXT-X-VERSION:3"];
  master.push("#EXT-X-STREAM-INF:BANDWIDTH=25200000,CODECS=\"avc1.640028,mp4a.40.2\"");
  master.push(`video.m3u8?v=${state.mediaVersion}`, "");
  fs.writeFileSync(path.join(state.hlsDirectory, "master.m3u8"), master.join("\n"));
}

module.exports = { writePlaylists };
