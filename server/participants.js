const { permissionsFor, permissionKey, isRoomCreator } = require("./permissions");

function participants(state, requesterId) {
  const requester = state.clients.get(requesterId);
  const host = state.clients.get(state.hostId);
  return [
    ...[...state.clients].map(([clientId, client]) => ({ clientId, name: client.name, role: client.role,
      ...(requester ? { sameBrowser: permissionKey(client, clientId) === permissionKey(requester, requesterId) } : {}),
      hostBrowser: Boolean(host && permissionKey(client, clientId) === permissionKey(host, state.hostId)),
      connected: true, blocked: false, isCreator: isRoomCreator(state, clientId), suppliesVideo: state.sourceOwnerId === clientId,
      permissions: permissionsFor(state, client, clientId),
      permissionOverrides: { ...state.viewerPermissions.get(permissionKey(client, clientId)) } })),
    ...[...state.blockedParticipants.values()].map(record => ({ clientId: record.clientId, name: record.name,
      role: "viewer", connected: false, blocked: true, suppliesVideo: false, permissions: record.permissions }))
  ];
}

module.exports = { participants };
