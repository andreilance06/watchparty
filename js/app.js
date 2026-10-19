import { getElements, setConnectionStatus } from "./dom.js";
import { createClientState } from "./state.js";
import { createConnection } from "./connection.js";
import { createChat } from "./chat.js";
import { createParty } from "./party.js";
import { createPlayer } from "./player/controller.js";
import { createVoting } from "./voting.js";
import { initializeTheme } from "./theme.js";

const elements = getElements();
initializeTheme(elements.themeToggle, undefined, document.documentElement, elements.video);
const state = createClientState();
const connection = createConnection({
  getIdentity: () => ({ clientId: state.clientId, name: state.clientName }),
  onMessage: handleMessage,
  onStatus: (connected, text) => setConnectionStatus(elements, connected, text)
});
const chat = createChat({ elements, state, send: connection.send });
const party = createParty({ elements, send: connection.send });
const player = createPlayer({ elements, state, send: connection.send, report: chat.addSystemMessage });
const voting = createVoting({ elements, send: connection.send });

function handleMessage(message) {
  switch (message.type) {
    case "role":
      state.clientId = message.clientId;
      if (message.name) chat.acceptName(message.name);
      if (message.nameRejected) chat.addSystemMessage(`“${message.nameRejected}” is already in use. You joined as ${state.clientName}.`);
      player.applyRole(message.role);
      elements.viewerCount.textContent = `${message.viewerCount} online`;
      break;
    case "presence":
      elements.viewerCount.textContent = `${message.count} online`;
      party.updateParticipants(message.participants);
      break;
    case "party-state":
      party.updateParticipants(message.participants);
      voting.applyState(message);
      break;
    case "reaction": party.receiveReaction(message); break;
    case "session-state": player.applySessionState(message); break;
    case "transcode-info": player.updateEncoder(message.encoder); break;
    case "media-error": player.showMediaError(message.message); break;
    case "chat": chat.receive(message); break;
    case "name-updated":
    case "name-rejected": chat.handleNameMessage(message); break;
    case "host-left":
      player.showNoVideo("Host disconnected");
      chat.addSystemMessage("The host left. Waiting for a new host...");
      break;
    case "error": chat.addSystemMessage(message.message); break;
  }
}

connection.connect();
