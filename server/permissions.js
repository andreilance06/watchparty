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
const HOST_PERMISSIONS = Object.freeze(Object.fromEntries(PERMISSION_CATALOG.map(item => [item.key, true])));

function permissionKey(client, clientId) { return client.permissionIdentity || clientId; }

function isRoomCreator(state, clientId) {
  const client = state.clients.get(clientId);
  return Boolean(client && (state.creatorMemberId === clientId ||
    state.creatorIdentity && state.creatorIdentity === permissionKey(client, clientId)));
}

function permissionsFor(state, client, clientId) {
  return client.role === "host" ? HOST_PERMISSIONS
    : { ...DEFAULT_PERMISSIONS, ...state.roomPermissions, ...state.viewerPermissions.get(permissionKey(client, clientId)) };
}

function promoteHost(state, clientId) {
  state.hostId = clientId;
  const client = state.clients.get(clientId);
  if (client) {
    client.role = "host";
    state.hostIdentity = permissionKey(client, clientId);
    state.hostName = client.name;
    state.viewerPermissions.delete(permissionKey(client, clientId));
  }
}

function can(state, clientId, key) {
  const client = state.clients.get(clientId);
  return Boolean(client && permissionsFor(state, client, clientId)[key]);
}
function permissionSnapshot(state, client, clientId) {
  return { permissions: permissionsFor(state, client, clientId),
    roomPermissions: { ...DEFAULT_PERMISSIONS, ...state.roomPermissions },
    permissionOverrides: { ...state.viewerPermissions.get(permissionKey(client, clientId)) } };
}
module.exports = { PERMISSION_CATALOG, DEFAULT_PERMISSIONS, HOST_PERMISSIONS, permissionKey, permissionsFor, permissionSnapshot, can, promoteHost, isRoomCreator };
