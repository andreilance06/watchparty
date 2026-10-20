export function getElements(root = document) {
  const ids = [
    "participantDropdown", "participantDetails", "participantStatus",
    "fileSharingStatus",
    "video", "videoShell", "videoPlaceholder", "hostControls", "chooseVideoButton",
    "viewerControls", "fullscreenButton", "roleBadge", "connectionStatus", "statusDot",
    "fileName", "syncStatus", "viewerCount", "nameForm",
    "displayNameInput", "participantList", "reactionFeed", "floatingReactions", "reactLove", "reactLaugh", "reactWow",
    "reactClap", "reactSad", "suggestionForm", "suggestionInput", "voteLeader",
    "chatMessages", "chatForm", "chatInput", "chatEmojiButton", "emojiPicker", "emojiSearch",
    "emojiPickerGrid", "emojiPickerEmpty", "voteOptions", "voteStatus", "themeToggle",
    "addCaptionsButton", "removeCaptionButton", "suggestionResults", "suggestionStatus",
    "roomEntry", "roomEntryChoices", "createRoomChoice", "joinRoomChoice", "initialDisplayName", "initialDisplayNameField",
    "createRoomForm", "createRoomName", "createRoomCode", "createRoomPassword", "createRoomBack",
    "joinRoomForm", "joinRoomCode", "joinRoomPassword", "joinRoomBack", "continuePublicRoom",
    "roomEntryStatus", "roomEntrySuccess", "createdRoomCode", "copyRoomCode", "roomInviteLink",
    "enterCreatedRoom", "roomActionButton", "roomActionStatus",
    "roomInfo", "roomInfoToggle", "roomInfoName", "roomInfoDetails", "roomInfoCode",
    "copyCurrentRoomCode", "roomInfoStatus"
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
