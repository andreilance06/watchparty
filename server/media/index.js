const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { createPlayback, sessionState } = require("../state");
const { probeMedia } = require("./probe");
const { writePlaylists } = require("./playlists");
const { removeTempDirectory } = require("./temp-files");
const { createSegmentService } = require("./segments");
const { createSubtitleService } = require("./subtitles");

function createMediaService({ state, config, encoderPromise, broadcast }) {
  const segments = createSegmentService({ state, config, encoderPromise, broadcast });
  const subtitlesService = createSubtitleService({ state, config });
  let probeController;
  let nextCaption = 0;
  let captionQueue = Promise.resolve();

  function stop() {
    probeController?.abort();
    segments.cancel();
    subtitlesService.stop();
  }

  function select(sourcePath, fileName = path.basename(sourcePath)) {
    state.mediaPath = sourcePath;
    state.mediaVersion += 1;
    state.fileName = fileName;
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

  function assignCaption(subtitle) {
    return { ...subtitle, id: crypto.randomUUID(), fileName: `captions_${nextCaption++}.ass` };
  }

  async function prepareMedia(sourcePath, externalCaptions = []) {
    stop();
    probeController = new AbortController();
    const controller = probeController;
    nextCaption = 0;
    const oldDirectory = state.hlsDirectory;
    state.hlsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "watchparty-hls-"));
    if (oldDirectory) removeTempDirectory(oldDirectory);
    const version = state.mediaVersion;
    try {
      const [encoder, probe] = await Promise.all([encoderPromise, probeMedia(sourcePath, config.ffmpegPath, controller.signal)]);
      if (version !== state.mediaVersion || !state.mediaPath || !state.hlsDirectory) return;
      state.selectedEncoder = encoder.label;
      state.mediaDuration = probe.duration;
      const subtitles = [...probe.subtitles, ...externalCaptions].slice(0, 16).map(assignCaption);
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
      broadcast({ type: "media-error", message: "The selected video could not be prepared. Check that the host's file is available and supported by FFmpeg." });
    }
  }

  function reset() {
    if (state.mediaPath || state.hlsDirectory || state.mediaProcessing) state.mediaVersion += 1;
    state.mediaPath = null;
    state.sourceId = null;
    state.fileName = null;
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

  function captionMutation(work) {
    const version = state.mediaVersion;
    const task = captionQueue.catch(() => {}).then(async () => {
      if (!state.mediaReady || version !== state.mediaVersion) throw new Error("The video source changed.");
      const result = await work(version);
      if (version !== state.mediaVersion) throw new Error("The video source changed.");
      broadcast({ type: "captions-updated", mediaVersion: version, captions: state.captionTracks });
      return result;
    });
    captionQueue = task;
    return task;
  }

  function addCaptions(files) {
    return captionMutation(async (version) => {
      if (state.captionTracks.length + files.length > 16) throw new Error("A video can have at most 16 caption tracks.");
      const declared = files.map(assignCaption);
      const tracks = (await Promise.all(declared.map((file) => subtitlesService.extract(file, version)))).filter(Boolean);
      if (version !== state.mediaVersion) throw new Error("The video source changed.");
      if (tracks.length !== files.length) {
        declared.forEach((file) => subtitlesService.remove(file.fileName));
        throw new Error("Some caption files could not be converted.");
      }
      state.captionTracks.push(...tracks);
      return tracks;
    });
  }

  function removeCaption(trackId) {
    return captionMutation(() => {
      const index = state.captionTracks.findIndex((track) => track.id === trackId);
      if (index < 0) throw new Error("Caption track not found.");
      const [track] = state.captionTracks.splice(index, 1);
      subtitlesService.remove(/\/(captions_\d+\.ass)\?/.exec(track.url)[1]);
      return track;
    });
  }

  return {
    select,
    prepare: prepareMedia,
    reset,
    addCaptions,
    removeCaption,
    stop,
    ensureSegment: segments.ensure,
    cancelSegmentJobs: segments.cancel,
    waitForCaption: subtitlesService.wait
  };
}

module.exports = { createMediaService };
