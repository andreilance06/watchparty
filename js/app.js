import { getElements, setConnectionStatus } from "./dom.js";
import { createClientState } from "./state.js";
import { createConnection } from "./connection.js";
import { createChat } from "./chat.js";
import { createParty } from "./party.js";
import { createPlayer } from "./player/controller.js";
import { createVoting } from "./voting.js";
import { initializeTheme } from "./theme.js";
import { createHostFiles } from "./host-files.js";
import { initializeRoomEntry } from "./room-entry.js";

const elements = getElements();
initializeTheme(elements.themeToggle, undefined, document.documentElement, elements.video);
const state = createClientState();
let stopCurrentConnection = () => {};
const roomEntryPending = initializeRoomEntry(elements, {
  guestName: state.guestName,
  onLeave: () => stopCurrentConnection()
});
const roomId = new URLSearchParams(location.search || "").get("roomId");
let socketPath = "/";
if (roomId) {
  try {
    const response = await fetch(`/rooms/${encodeURIComponent(roomId)}/api/session`);
    if (!response.ok) throw new Error("Join this room before opening its watch page.");
    const session = await response.json();
    socketPath = session.endpoints.websocket;
    elements.roomInfoName.textContent = session.room.name;
    elements.roomInfoCode.textContent = session.room.accessCode || "No access code (public room)";
    elements.copyCurrentRoomCode.hidden = !session.room.accessCode;
    elements.roomInfo.hidden = false;
  } catch (error) {
    setConnectionStatus(elements, false, error.message);
    throw error;
  }
}
let files;
const connection = createConnection({
  path: socketPath,
  getIdentity: () => ({ clientId: state.clientId, name: state.clientName }),
  onMessage: handleMessage,
  onStatus: (connected, text) => {
    setConnectionStatus(elements, connected, text);
    if (!connected) files?.disconnect();
  }
});
stopCurrentConnection = connection.dispose;
const chat = createChat({ elements, state, send: connection.send });
files = createHostFiles({ send: connection.send, report: chat.addSystemMessage });
const party = createParty({ elements, send: connection.send });
const player = createPlayer({ elements, state, send: connection.send, report: chat.addSystemMessage, files });
const voting = createVoting({ elements, state, send: connection.send });

function handleMessage(message) {
  if (files.handleMessage(message)) return;
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
    case "comment-reaction": chat.receiveCommentReaction(message); break;
    case "session-state": player.applySessionState(message); break;
    case "captions-updated": player.updateCaptions(message); break;
    case "compatibility-ready": player.applyCompatibility(message); break;
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

if (roomEntryPending) {
  let publicConnectionStarted = false;
  elements.continuePublicRoom.addEventListener("click", () => {
    if (publicConnectionStarted) return;
    publicConnectionStarted = true;
    connection.connect();
  });
} else {
  connection.connect();
}
