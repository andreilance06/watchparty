import { canControl } from "../permissions.js";

export function createPlaybackSync({ elements, state: session, send }) {
  const { video, syncStatus } = elements;
  let sequence = 0, commandSequence = 0, pendingSeek, queuedTransport, queuedRate;
  let appliedRate;
  let cleanup = () => {}, applying = false, settle = () => {};
  const surface = () => video.player?.getHLSVideoElement?.() || video.player?.getVideoElement?.() || video;

  function cancel() {
    sequence++;
    cleanup(); cleanup = () => {};
    settle = () => {};
    applying = false;
  }

  function accept(state) {
    if (Number.isFinite(state.mediaVersion) && Number.isFinite(session.mediaVersion) && state.mediaVersion < session.mediaVersion) return false;
    if (state.mediaVersion !== session.mediaVersion) pendingSeek = queuedTransport = queuedRate = null;
    if (state.mediaVersion === session.mediaVersion &&
        (state.playbackRevision ?? 0) < (session.playbackRevision ?? 0)) return false;
    if (state.syncMode === "host-transfer") pendingSeek = queuedTransport = queuedRate = null;
    if (pendingSeek && state.mediaVersion === session.mediaVersion) {
      if (state.syncMode !== "seek") return false;
      const own = !state.commandClientId || state.commandClientId === session.clientId;
      if (own && state.seekSequence < pendingSeek) return false;
      if (!own) {
        if ((state.playbackRevision ?? 0) <= (session.playbackRevision ?? 0)) return false;
        queuedTransport = queuedRate = null;
      }
      pendingSeek = null;
    }
    session.playbackRevision = state.playbackRevision ?? 0;
    return true;
  }

  function apply(state, sourceChanged) {
    if (queuedTransport && canControl(session, queuedTransport)) state = { ...state, paused: queuedTransport === "pause" };
    if (Number.isFinite(queuedRate) && canControl(session, "rate")) state = { ...state, playbackRate: queuedRate };
    const mode = state.syncMode || "tick";
    // The host owns its clock. Viewer play/pause remains shared.
    if (session.role === "host" && !sourceChanged && !["source", "join", "seek", "play", "pause", "rate", "correction", "host-transfer"].includes(mode)) return;
    if (applying && !sourceChanged && mode === "tick") return;
    cancel();
    const token = sequence;
    applying = true;
    session.suppressVideoEvents = true;
    const native = surface();
    const listeners = [];
    const listen = (target, type, fn) => {
      target.addEventListener(type, fn);
      listeners.push(() => target.removeEventListener(type, fn));
    };
    cleanup = () => listeners.splice(0).forEach(remove => remove());
    let initiated = false, setting = false;
    const finish = () => {
      const active = surface();
      if (!applying || token !== sequence || setting || !initiated || active.seeking || active.readyState < 2) return;
      cleanup();
      applying = false;
      settle = () => {};
      session.sourceSwitching = false;
      session.suppressVideoEvents = false;
      if (Number.isFinite(queuedRate)) { queuedRate = null; appliedRate = undefined; broadcastVideoState("rate"); }
      if (queuedTransport) { const intent = queuedTransport; queuedTransport = null; broadcastVideoState(intent); }
    };
    const applyPlayback = () => {
      if (initiated || token !== sequence || state.mediaVersion !== session.mediaVersion) return;
      initiated = true; setting = true;
      const active = surface();
      const difference = Number.isFinite(state.time) ? state.time - active.currentTime : 0;
      const hardSync = sourceChanged || ["source", "join", "seek", "correction"].includes(mode);
      const threshold = hardSync ? 0.25 : mode === "tick" ? 1 : mode === "pause" ? 0.75 : 1.5;
      const hostRate = Number.isFinite(state.playbackRate) ? state.playbackRate : 1;
      let targetRate = hostRate;
      if (session.role === "viewer" && mode === "tick" && !state.paused && Math.abs(difference) >= 0.12 && Math.abs(difference) <= 1) {
        targetRate += Math.max(-0.05, Math.min(0.05, difference * 0.1));
      }
      appliedRate = targetRate;
      if (Math.abs(video.playbackRate - targetRate) > 0.005) video.playbackRate = targetRate;
      if (Number.isFinite(state.time) && Math.abs(difference) > threshold) video.currentTime = state.time;
      if (state.paused) {
        if (!active.paused) video.pause();
        syncStatus.textContent = session.role === "host"
          ? `You control playback${session.activeEncoder ? ` • ${session.activeEncoder}` : ""}` : "Paused";
      } else {
        syncStatus.textContent = session.role === "host" ? "You control playback" : "Synchronized with host";
        if (active.paused) video.play().catch(() => { syncStatus.textContent = "Tap fullscreen once if your browser blocks playback"; });
      }
      setting = false;
      queueMicrotask(finish);
    };
    listen(native, "seeked", finish);
    listen(native, "canplay", finish);
    listen(native, "loadeddata", finish);
    settle = () => {
      if (!initiated && surface().readyState >= 1) applyPlayback();
      else finish();
    };
    if (native.readyState >= 1) applyPlayback();
    else {
      listen(native, "loadedmetadata", applyPlayback);
      if (native !== video) listen(video, "loadedmetadata", applyPlayback);
    }
  }

  function broadcastVideoState(syncMode = "tick", target) {
    if (syncMode === "rate" && isAppliedRate()) return;
    if (!canControl(session, syncMode) || session.sourceSwitching || session.suppressVideoEvents || !session.activeMediaUrl) return;
    // A play/pause immediately following a seek belongs to the new revision;
    // retain that intent until its acknowledgement has settled locally.
    if (pendingSeek) {
      if (["play", "pause"].includes(syncMode)) { queuedTransport = syncMode; return; }
      if (syncMode === "rate") { queuedRate = video.playbackRate; return; }
    }
    if (pendingSeek && syncMode !== "seek") return;
    const native = surface();
    const number = ++commandSequence;
    if (syncMode === "seek") pendingSeek = number;
    // Movi can emit transport intent before it changes the native element.
    const paused = syncMode === "play" ? false : syncMode === "pause" ? true : native.paused;
    session.latestHostPaused = paused;
    const sent = send({ type: "video-state", mediaVersion: session.mediaVersion,
      playbackRevision: session.playbackRevision ?? 0, commandSequence: number,
      paused, time: Number.isFinite(target) ? target : native.currentTime,
      playbackRate: video.playbackRate, syncMode });
    if (sent === false) pendingSeek = queuedTransport = queuedRate = null;
  }

  function reject(message) {
    if (pendingSeek && message.commandSequence !== pendingSeek) return false;
    pendingSeek = queuedTransport = queuedRate = null;
    return true;
  }

  // Native ratechange can arrive after seek/canplay has released suppression.
  // Drift correction must never become a viewer's shared speed command.
  function isAppliedRate() { return Number.isFinite(appliedRate) && Math.abs(video.playbackRate - appliedRate) <= 0.005; }

  return { apply, accept, cancel, reject, isAppliedRate, update: () => settle(), isApplying: () => applying, broadcast: broadcastVideoState };
}
