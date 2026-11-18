const { PERMISSION_CATALOG, DEFAULT_PERMISSIONS } = require("../shared/permission-catalog.mjs");
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
