export function createPlaybackSync({ elements, state: session, send }) {
  const { video, syncStatus } = elements;

  function apply(state, sourceChanged) {
    const applyPlayback = () => {
      session.suppressVideoEvents = true;
      const mode = state.syncMode || "tick";
      const difference = Number.isFinite(state.time) ? state.time - video.currentTime : 0;
      const hardSync = sourceChanged || mode === "source" || mode === "join" || mode === "seek";
      const correctionThreshold = mode === "tick" ? 1 : mode === "pause" ? 0.75 : 1.5;
  
      const hostRate = Number.isFinite(state.playbackRate) ? state.playbackRate : 1;
      let targetRate = hostRate;
      if (session.role === "viewer" && mode === "tick" && !state.paused && Math.abs(difference) >= 0.12 && Math.abs(difference) <= 1) {
        targetRate = hostRate + Math.max(-0.05, Math.min(0.05, difference * 0.1));
      }
      if (Math.abs(video.playbackRate - targetRate) > 0.005) {
        video.playbackRate = targetRate;
      }
  
      if (Number.isFinite(state.time) && Math.abs(difference) > (hardSync ? 0.25 : correctionThreshold)) {
        video.currentTime = state.time;
      }
  
      if (state.paused) {
        if (!video.paused) video.pause();
        syncStatus.textContent = session.role === "host"
          ? `You control playback${session.activeEncoder ? ` • ${session.activeEncoder}` : ""}`
          : "Paused";
      } else {
        if (video.paused) {
          video.play().then(() => {
            syncStatus.textContent = session.role === "host"
              ? "You control playback"
              : video.muted ? "Tap fullscreen to enable audio" : "Synchronized with host";
          }).catch(() => { syncStatus.textContent = "Tap fullscreen once if your browser blocks playback"; });
        } else {
          syncStatus.textContent = session.role === "host"
            ? "You control playback"
            : video.muted ? "Tap fullscreen to enable audio" : "Synchronized with host";
        }
      }
      setTimeout(() => { session.suppressVideoEvents = false; }, hardSync ? 400 : 100);
    };
    if (video.readyState >= 1) applyPlayback();
    else video.addEventListener("loadedmetadata", applyPlayback, { once: true });
  }

  function broadcastVideoState(syncMode = "tick") {
    const viewerPlayPause = session.role === "viewer" && (syncMode === "play" || syncMode === "pause");
    if ((session.role !== "host" && !viewerPlayPause) || session.suppressVideoEvents || !session.activeMediaUrl) return;
    send({
      type: "video-state",
      paused: video.paused,
      time: video.currentTime,
      playbackRate: video.playbackRate,
      syncMode
    });
  }

  return { apply, broadcast: broadcastVideoState };
}
