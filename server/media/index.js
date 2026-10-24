const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { createPlayback, sessionState } = require("../state");
const { probeMedia } = require("./probe");
const { writePlaylists, segmentSchedule } = require("./playlists");
const { removeTempDirectory } = require("./temp-files");
const { createSegmentService } = require("./segments");
const { createRenditionService } = require("./renditions");
const { qualityOptions, BITRATES } = require("./quality");
const { createSubtitleService } = require("./subtitles");

function createMediaService({ state, config, encoderPromise, broadcast }) {
  const segments = createSegmentService({ state, config, encoderPromise, broadcast });
  const renditions = createRenditionService({ state, config, encoderPromise, broadcast });
  const subtitlesService = createSubtitleService({ state, config });
  let probeController;
  let nextCaption = 0;
  let captionQueue = Promise.resolve();

  function stop() {
    probeController?.abort();
    segments.cancel();
    renditions.stop();
    subtitlesService.stop();
  }

  function select(sourcePath, fileName = path.basename(sourcePath)) {
    state.mediaPath = sourcePath;
    state.mediaVersion += 1;
    state.playbackRevision += 1;
    state.streamGeneration = 0;
    state.compatibilityStartIndex = 0;
    state.fileName = fileName;
    state.mediaDuration = 0;
    state.mediaInfo = null;
    state.sourcePerformance = null;
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

  async function prepareMedia(sourcePath, externalCaptions = [], sourceReader) {
    stop();
    probeController = new AbortController();
    const controller = probeController;
    nextCaption = 0;
    const oldDirectory = state.hlsDirectory;
    state.hlsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "watchparty-hls-"));
    if (oldDirectory) removeTempDirectory(oldDirectory);
    const version = state.mediaVersion;
    subtitlesService.setSource(sourceReader);
    try {
      const probe = await probeMedia(sourcePath, config.ffmpegPath, controller.signal, state.fileName);
      if (version !== state.mediaVersion || !state.mediaPath || !state.hlsDirectory) return;
      state.selectedEncoder = "Direct playback";
      state.mediaDuration = probe.duration;
      state.mediaInfo = probe.info;
      state.mediaInfo.sourceSize = sourceReader?.size || 0;
      state.mediaInfo.bitrate = sourceReader?.size ? sourceReader.size * 8 / probe.duration : probe.info.bitrate || 0;
      state.mediaInfo.qualityOptions = qualityOptions(state.mediaInfo);
      state.mediaInfo.bitrateLimits = BITRATES;
      subtitlesService.setFonts(probe.fonts, version);
      const subtitles = [...probe.subtitles, ...externalCaptions].slice(0, 16).map(assignCaption);
      writePlaylists(state, config.segmentSeconds);
      const extracted = subtitles.map((subtitle) => subtitlesService.register(subtitle, version));
      if (version !== state.mediaVersion || !state.mediaPath || !state.hlsDirectory) return;
      state.captionTracks = extracted;
      state.mediaReady = true;
      state.mediaProcessing = false;
      broadcast(sessionState(state, "source"));
      // Some legacy subtitle streams are absent from FFmpeg's short probe.
      // Discover them without holding up the first frame or extracting payloads.
      subtitlesService.discover().then((discovered) => {
        if (version !== state.mediaVersion || controller.signal.aborted) return;
        const missing = discovered.filter((track) => !probe.subtitles.some((original) =>
          original.streamId != null ? original.streamId === track.streamId : original.map === track.map));
        const additions = missing.slice(0, Math.max(0, 16 - state.captionTracks.length))
          .map(assignCaption).map((track) => subtitlesService.register(track, version));
        if (!additions.length) return;
        state.captionTracks.push(...additions);
        broadcast({ type: "captions-updated", mediaVersion: version, captions: state.captionTracks });
      }).catch(() => {}); // Selected unsupported tracks report their own caption error.
    } catch (error) {
      if (version !== state.mediaVersion) return;
      state.mediaProcessing = false;
      broadcast({ type: "media-error", message: "The selected video could not be prepared. Check that the host's file is available and supported by FFmpeg." });
    }
  }

  function reset() {
    if (state.mediaPath || state.hlsDirectory || state.mediaProcessing) state.mediaVersion += 1;
    state.playbackRevision += 1;
    state.mediaPath = null;
    state.sourceId = null;
    state.sourceOwnerId = null;
    state.fileName = null;
    state.mediaReady = false;
    state.mediaProcessing = false;
    state.mediaDuration = 0;
    state.mediaInfo = null;
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
    selectQuality: renditions.select,
    commitQuality: renditions.commit,
    touchQuality: renditions.touch,
    releaseQuality: renditions.release,
    rendition: renditions.get,
    qualityDemand: renditions.demand,
    segmentSeconds: () => segmentSchedule(state, config.segmentSeconds).seconds,
    ensureSegment: segments.ensure,
    cancelSegmentJobs: segments.cancel,
    restartStream: (...args) => { segments.restart(...args); renditions.restart(); },
    waitForCaption: subtitlesService.wait,
    captionMetrics: subtitlesService.metrics,
    waitForFonts: subtitlesService.waitForFonts,
    fontFiles: subtitlesService.fontFiles
  };
}

module.exports = { createMediaService };
