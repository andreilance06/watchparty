const path = require("path");

function createPlayback() {
  return { paused: true, time: 0, rate: 1, updatedAt: Date.now() };
}

function createSession() {
  return {
    clients: new Map(),
    viewerPermissions: new Map(),
    blockedParticipants: new Map(),
    sourceId: null,
    sourceOwnerId: null,
    hostId: null,
    hostIdentity: null,
    hostName: null,
    hostReconnectUntil: null,
    creatorIdentity: null,
    creatorMemberId: null,
    basePath: "",
    fileName: null,
    mediaPath: null,
    mediaVersion: 0,
    playbackRevision: 0,
    streamGeneration: 0,
    compatibilityStartIndex: 0,
    mediaDuration: 0,
    mediaInfo: null,
    mediaReady: false,
    mediaProcessing: false,
    captionTracks: [],
    poll: { id: null, status: "idle", result: null },
    suggestionOwners: new Map(),
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
  const compatibilityUrl = state.mediaPath && state.mediaReady
    ? `${state.basePath || ""}/hls/master.m3u8?v=${state.mediaVersion}&g=${state.streamGeneration || 0}` : null;
  return {
    type: "session-state", hasVideo: Boolean(state.mediaPath && state.mediaReady),
    sourceId: state.sourceId, sourceOwnerId: state.sourceOwnerId,
    processing: state.mediaProcessing, mediaVersion: state.mediaVersion,
    mediaUrl: compatibilityUrl,
    playbackRevision: state.playbackRevision,
    streamGeneration: state.streamGeneration,
    captions: state.captionTracks,
    originalUrl: state.mediaPath && state.mediaReady ? `${state.basePath || ""}/media/original?v=${state.mediaVersion}` : null,
    compatibilityUrl,
    mediaInfo: state.mediaInfo,
    fileName: state.mediaPath ? state.fileName || path.basename(state.mediaPath) : null,
    duration: state.mediaDuration, encoder: state.selectedEncoder,
    paused: state.playback.paused, time: currentTime(state), playbackRate: state.playback.rate,
    syncMode
  };
}

module.exports = { createSession, createPlayback, currentTime, sessionState };
