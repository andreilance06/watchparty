const fs = require("fs");
const path = require("path");
const os = require("os");
const { createPlayback, sessionState } = require("../state");
const { probeMedia, findSidecarSubtitles } = require("./probe");
const { writePlaylists } = require("./playlists");
const { removeTempDirectory } = require("./temp-files");
const { createSegmentService } = require("./segments");
const { createSubtitleService } = require("./subtitles");

function createMediaService({ state, config, encoderPromise, broadcast }) {
  const segments = createSegmentService({ state, config, encoderPromise, broadcast });
  const subtitlesService = createSubtitleService({ state, config });

  function stop() {
    segments.cancel();
    subtitlesService.stop();
  }

  function select(sourcePath) {
    state.mediaPath = sourcePath;
    state.mediaVersion += 1;
    state.mediaDuration = 0;
    state.captionTracks = [];
    state.mediaReady = false;
    state.mediaProcessing = true;
    state.selectedEncoder = "Detecting hardware";
    state.playback = createPlayback();
    const snapshot = sessionState(state, "source");
    broadcast(snapshot);
    return snapshot;
  }

  async function prepareMedia(sourcePath) {
    stop();
    const oldDirectory = state.hlsDirectory;
    state.hlsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "watchparty-hls-"));
    if (oldDirectory) setTimeout(() => removeTempDirectory(oldDirectory), 15000);
    const version = state.mediaVersion;
    try {
      const [encoder, probe] = await Promise.all([encoderPromise, probeMedia(sourcePath, config.ffmpegPath)]);
      if (version !== state.mediaVersion || !state.mediaPath || !state.hlsDirectory) return;
      state.selectedEncoder = encoder.label;
      state.mediaDuration = probe.duration;
      const subtitles = [...probe.subtitles, ...findSidecarSubtitles(sourcePath)].slice(0, 16);
      subtitles.forEach((subtitle, index) => { subtitle.fileName = `captions_${index}.ass`; });
      writePlaylists(state, config.segmentSeconds);
      const extracted = (await Promise.all(subtitles.map((subtitle) => subtitlesService.extract(subtitle, version)))).filter(Boolean);
      if (version !== state.mediaVersion || !state.mediaPath || !state.hlsDirectory) return;
      const languageCounts = new Map();
      state.captionTracks = extracted.map((track) => {
        const count = (languageCounts.get(track.lang) || 0) + 1;
        languageCounts.set(track.lang, count);
        return { ...track, lang: count === 1 ? track.lang : `${track.lang}-${count}` };
      });
      state.mediaReady = true;
      state.mediaProcessing = false;
      broadcast(sessionState(state, "source"));
    } catch (error) {
      if (version !== state.mediaVersion) return;
      state.mediaProcessing = false;
      broadcast({ type: "media-error", message: error.message || "The selected video could not be prepared." });
    }
  }

  function reset() {
    state.mediaPath = null;
    state.mediaReady = false;
    state.mediaProcessing = false;
    state.mediaDuration = 0;
    state.captionTracks = [];
    state.playback = createPlayback();
    stop();
    const directory = state.hlsDirectory;
    state.hlsDirectory = null;
    removeTempDirectory(directory);
  }

  return {
    select,
    prepare: prepareMedia,
    reset,
    stop,
    ensureSegment: segments.ensure,
    cancelSegmentJobs: segments.cancel,
    waitForCaption: subtitlesService.wait
  };
}

module.exports = { createMediaService };
