const PERMISSION_CATALOG = Object.freeze([
  { key: "playPause", label: "Play/pause", group: "Playback", default: true },
  { key: "seek", label: "Seek", group: "Playback", default: false },
  { key: "playbackRate", label: "Playback speed", group: "Playback", default: false },
  { key: "chooseVideo", label: "Choose/replace video", group: "Media", default: false },
  { key: "addCaptions", label: "Add captions", group: "Media", default: false },
  { key: "removeCaptions", label: "Remove captions", group: "Media", default: false },
  { key: "sendChat", label: "Send messages", group: "Chat", default: true },
  { key: "replyChat", label: "Send replies", group: "Chat", default: true },
  { key: "reactMessages", label: "React to messages", group: "Chat", default: true },
  { key: "globalReactions", label: "Send floating reactions", group: "Chat", default: true },
  { key: "startPoll", label: "Start polls", group: "Polls", default: false },
  { key: "finishPoll", label: "Finish polls", group: "Polls", default: false },
  { key: "suggestTitles", label: "Suggest titles", group: "Polls", default: true },
  { key: "vote", label: "Vote", group: "Polls", default: true },
  { key: "removeOwnSuggestions", label: "Remove own suggestions", group: "Polls", default: true },
  { key: "removeAnySuggestion", label: "Remove any suggestion", group: "Polls", default: false },
  { key: "changeName", label: "Change display name", group: "Identity", default: true },
  { key: "blockViewers", label: "Block viewers", group: "Moderation", default: false },
  { key: "unblockViewers", label: "Unblock viewers", group: "Moderation", default: false },
].map(Object.freeze));
const DEFAULT_PERMISSIONS = Object.freeze(Object.fromEntries(PERMISSION_CATALOG.map(item => [item.key, item.default])));
export { PERMISSION_CATALOG, DEFAULT_PERMISSIONS };
export function can(state, key) {
  return state.role === "host" || Boolean(({ ...DEFAULT_PERMISSIONS, ...state.permissions })[key]);
}
export function canControl(state, mode) {
  return can(state, ({ play: "playPause", pause: "playPause", seek: "seek", rate: "playbackRate" })[mode]);
}
