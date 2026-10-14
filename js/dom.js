export function getElements(root = document) {
  const ids = [
    "video", "videoShell", "videoPlaceholder", "hostControls", "chooseVideoButton",
    "viewerControls", "fullscreenButton", "roleBadge", "connectionStatus", "statusDot",
    "fileName", "syncStatus", "captionControl", "captionSelect", "viewerCount", "nameForm",
    "displayNameInput", "chatMessages", "chatForm", "chatInput", "voteOptions", "voteStatus", "themeToggle"
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, root.querySelector(`#${id}`)]));
  elements.placeholderTitle = elements.videoPlaceholder.querySelector("strong");
  elements.placeholderText = elements.videoPlaceholder.querySelector("span:last-child");
  return elements;
}

export function setConnectionStatus(elements, connected, text) {
  elements.connectionStatus.textContent = text;
  elements.statusDot.classList.toggle("online", connected);
  elements.statusDot.classList.toggle("offline", !connected);
}
