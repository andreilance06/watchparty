const path = require("path");

function createPlayback() {
  return { paused: true, time: 0, rate: 1, updatedAt: Date.now() };
}

function createSession() {
  return {
    clients: new Map(),
    hostId: null,
    mediaPath: null,
    mediaVersion: 0,
    mediaDuration: 0,
    mediaReady: false,
    mediaProcessing: false,
    captionTracks: [],
    videoSuggestions: [],
    videoVotes: new Map(),
    commentReactions: new Map(),
    nextSuggestionId: 1,
    hlsDirectory: null,
    selectedEncoder: "Detecting hardware",
    playback: createPlayback(),
    shuttingDown: false
  };
}

function currentTime(state) {
  const time = state.playback.paused
    ? state.playback.time
    : state.playback.time + ((Date.now() - state.playback.updatedAt) / 1000) * state.playback.rate;
  return state.mediaDuration ? Math.min(state.mediaDuration, Math.max(0, time)) : Math.max(0, time);
}

function sessionState(state, syncMode = "tick") {
  return {
    type: "session-state", hasVideo: Boolean(state.mediaPath && state.mediaReady),
    processing: state.mediaProcessing,
    mediaUrl: state.mediaPath && state.mediaReady ? `/hls/master.m3u8?v=${state.mediaVersion}` : null,
    captions: state.captionTracks,
    fileName: state.mediaPath ? path.basename(state.mediaPath) : null,
    duration: state.mediaDuration, encoder: state.selectedEncoder,
    paused: state.playback.paused, time: currentTime(state), playbackRate: state.playback.rate,
    syncMode
  };
}

module.exports = { createSession, createPlayback, currentTime, sessionState };
