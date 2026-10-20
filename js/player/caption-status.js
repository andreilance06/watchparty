export function captionStatusText({ status, phase, tracks }) {
  return ({ preparing: phase === "starting-renderer" ? "Starting caption renderer…" : "Loading captions and fonts…",
    ready: "Captions ready", error: "Could not prepare captions",
    off: tracks.length ? "Captions off" : "No captions added" })[status];
}

export function updateCaptionStatus(element, state) {
  let label = element.querySelector(".watchparty-caption-status-text");
  if (!label) {
    label = document.createElement("span");
    label.className = "watchparty-caption-status-text";
    element.appendChild(label);
  }
  const text = captionStatusText(state);
  if (label.textContent !== text) label.textContent = text;
  let spinner = element.querySelector(".movi-subtitle-pending");
  if (state.status === "preparing" && !spinner) {
    spinner = document.createElement("span");
    spinner.className = "movi-subtitle-pending";
    spinner.setAttribute("aria-hidden", "true");
    spinner.style.margin = "0 8px 0 0";
    element.insertBefore(spinner, label);
  } else if (state.status !== "preparing") spinner?.remove();
}
