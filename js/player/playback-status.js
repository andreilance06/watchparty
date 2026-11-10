// Shared presentation for captions and automatic quality, with independent lifetimes.
const OVERLAY_ID = "watchparty-playback-status";

export function updateStatusRow(element, { text, pending }, labelClass = "watchparty-status-text") {
  let label = element.querySelector(`.${labelClass}`);
  if (!label) {
    label = document.createElement("span"); label.className = labelClass; element.appendChild(label);
  }
  if (label.textContent !== text) label.textContent = text;
  let spinner = element.querySelector(".movi-subtitle-pending");
  if (pending && !spinner) {
    spinner = document.createElement("span"); spinner.className = "movi-subtitle-pending";
    spinner.setAttribute("aria-hidden", "true"); spinner.style.margin = "0 8px 0 0";
    element.insertBefore(spinner, label);
  } else if (!pending) spinner?.remove();
}

export function createPlaybackStatus(video) {
  const channels = new Map();
  const card = document.createElement("div");
  card.setAttribute("role", "status"); card.setAttribute("aria-live", "polite");
  Object.assign(card.style, { position: "absolute", top: "12px", left: "12px", maxWidth: "calc(100% - 48px)",
    padding: "8px 12px", font: "inherit", fontSize: "13px", color: "var(--movi-controls-color)",
    background: "var(--movi-glass-bg)", border: "1px solid var(--movi-glass-border)",
    borderRadius: "var(--movi-radius-surface)", boxShadow: "var(--movi-shadow-lg)", pointerEvents: "none",
    display: "flex", flexDirection: "column", gap: "8px" });
  let visible = false;
  function clear(channel) {
    const entry = channels.get(channel);
    if (!entry) return;
    clearTimeout(entry.timer); entry.row.remove(); channels.delete(channel);
    if (!channels.size) { video.hideOverlay?.(OVERLAY_ID); visible = false; }
  }
  function set(channel, { text, pending = false }) {
    let entry = channels.get(channel);
    if (entry?.text === text && entry.pending === pending) return;
    if (!entry) {
      const row = document.createElement("div"); row.dataset.statusChannel = channel;
      entry = { row }; channels.set(channel, entry); card.appendChild(row);
    }
    clearTimeout(entry.timer); Object.assign(entry, { text, pending });
    updateStatusRow(entry.row, entry, channel === "captions" ? "watchparty-caption-status-text" : "watchparty-quality-status-text");
    if (!visible) { video.showOverlay?.({ id: OVERLAY_ID, content: card, placement: "fill", interactive: false }); visible = true; }
    if (!pending) entry.timer = setTimeout(() => { if (channels.get(channel) === entry) clear(channel); }, 3000);
  }
  function clearAll() { for (const channel of [...channels.keys()]) clear(channel); }
  return { set, clear, clearAll, destroy: clearAll };
}
