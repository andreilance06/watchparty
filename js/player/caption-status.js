import { updateStatusRow } from "./playback-status.js";

export function captionStatusText({ status, phase, tracks }) {
  return ({ preparing: phase === "starting-renderer" ? "Starting caption renderer…" : "Loading captions and fonts…",
    ready: "Captions ready", error: "Could not prepare captions",
    off: tracks.length ? "Captions off" : "No captions added" })[status];
}

export function updateCaptionStatus(element, state) {
  updateStatusRow(element, { text: captionStatusText(state), pending: state.status === "preparing" }, "watchparty-caption-status-text");
}
