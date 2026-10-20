const { permissionsFor } = require("./permissions");

function participants(state) {
  return [
    ...[...state.clients].map(([clientId, client]) => ({ clientId, name: client.name, role: client.role,
      connected: true, blocked: false, suppliesVideo: state.sourceOwnerId === clientId,
      permissions: permissionsFor(state, client, clientId) })),
    ...[...state.blockedParticipants.values()].map(record => ({ clientId: record.clientId, name: record.name,
      role: "viewer", connected: false, blocked: true, suppliesVideo: false, permissions: record.permissions }))
  ];
}

module.exports = { participants };
