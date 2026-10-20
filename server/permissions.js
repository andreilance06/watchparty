const DEFAULT_PERMISSIONS = Object.freeze({ playPause: true, seek: false, playbackRate: false });
const HOST_PERMISSIONS = Object.freeze({ playPause: true, seek: true, playbackRate: true });

function permissionKey(client, clientId) { return client.permissionIdentity || clientId; }

function permissionsFor(state, client, clientId) {
  return client.role === "host" ? HOST_PERMISSIONS
    : state.viewerPermissions.get(permissionKey(client, clientId)) || DEFAULT_PERMISSIONS;
}

function promoteHost(state, clientId) {
  state.hostId = clientId;
  const client = state.clients.get(clientId);
  if (client) {
    client.role = "host";
    state.viewerPermissions.delete(permissionKey(client, clientId));
  }
}

module.exports = { DEFAULT_PERMISSIONS, permissionKey, permissionsFor, promoteHost };
