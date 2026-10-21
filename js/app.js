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
import { createParticipants } from "./participants.js";

const elements = getElements();
initializeTheme(elements.themeToggle, undefined, document.documentElement, elements.video);
const state = createClientState();
let stopCurrentConnection = () => {};
const roomEntryPending = initializeRoomEntry(elements, {
  guestName: state.guestName,
  onLeave: () => stopCurrentConnection()
});
const roomId = new URLSearchParams(location.search || "").get("roomId");
const blockedText = "You are blocked from this room until a host unblocks you.";
let admissionBlocked = false, publicConnectionStarted = false;
let socketPath = "/";
if (roomId) {
  try {
    const response = await fetch(`/rooms/${encodeURIComponent(roomId)}/api/session`);
    if (!response.ok) {
      const result = await response.json();
      if (result.code === "ROOM_BLOCKED") location.href = "/?blocked=1";
      throw new Error(result.error || "Join this room before opening its watch page.");
    }
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
try {
  const response = await fetch("/api/viewer-identity", { method: "POST" }).catch(() => {
    throw new Error("Could not establish viewer identity. Check your connection to the server, then reload.");
  });
  if (!response.ok) {
    let result;
    try { result = await response.json(); } catch {}
    const detail = typeof result?.error === "string" ? result.error.trim() : "";
    const guidance = response.status === 403 && detail === "Request origin is not allowed."
      ? "Check that PUBLIC_ORIGIN matches this page's HTTPS origin and TRUST_PROXY is configured for the tunnel."
      : "Reload to reconnect.";
    throw new Error(`Could not establish viewer identity (HTTP ${response.status}).${detail ? ` ${detail}` : ""} ${guidance}`);
  }
  if (!roomId) {
    const admission = await fetch("/api/session");
    if (!admission.ok) {
      const result = await admission.json();
      if (result.code === "ROOM_BLOCKED") admissionBlocked = true;
      else throw new Error(result.error || "Could not connect to the room.");
    }
  }
} catch (error) {
  setConnectionStatus(elements, false, error.message);
  throw error;
}
let files;
const connection = createConnection({
  path: socketPath,
  getIdentity: () => ({ clientId: state.clientId, name: state.clientName }),
  onMessage: handleMessage,
  onBlocked: showBlocked,
  beforeReconnect: async () => {
    const response = await fetch(roomId ? `/rooms/${encodeURIComponent(roomId)}/api/session` : "/api/session");
    if (!response.ok) {
      const result = await response.json();
      if (result.code === "ROOM_BLOCKED") { showBlocked(); return false; }
      throw new Error(result.error || "Could not reconnect.");
    }
  },
  onStatus: (connected, text) => {
    setConnectionStatus(elements, connected, text);
    if (!connected) files?.disconnect();
    participants.setConnected(connected);
    voting.setConnected(connected);
  }
});
stopCurrentConnection = connection.dispose;
const chat = createChat({ elements, state, send: connection.send });
files = createHostFiles({ send: connection.send, report: chat.addSystemMessage });
const party = createParty({ elements, send: connection.send });
const player = createPlayer({ elements, state, send: connection.send, report: chat.addSystemMessage, files });
const voting = createVoting({ elements, state, send: connection.send, report: chat.addSystemMessage });
const participants = createParticipants({ elements, state, send: connection.send });

function handleMessage(message) {
  if (files.handleMessage(message)) return;
  switch (message.type) {
    case "role":
      state.clientId = message.clientId;
      if (message.name) chat.acceptName(message.name);
      if (message.nameRejected) chat.addSystemMessage(`“${message.nameRejected}” is already in use. You joined as ${state.clientName}.`);
      player.applyRole(message.role);
      player.applyPermissions(message.permissions);
      participants.refresh();
      voting.refresh();
      elements.viewerCount.textContent = `${message.viewerCount} online`;
      break;
    case "presence":
      elements.viewerCount.textContent = `${message.count} online`;
      participants.updateParticipants(message.participants);
      applyParticipantPermissions(message.participants);
      break;
    case "party-state":
      elements.hostReconnectStatus.hidden = message.host?.status !== "reconnecting";
      elements.hostReconnectStatus.textContent = message.host?.status === "reconnecting"
        ? `${message.host.name || "The host"} is reconnecting. Waiting briefly before assigning a new host.` : "";
      participants.updateParticipants(message.participants);
      applyParticipantPermissions(message.participants);
      voting.applyState(message);
      break;
    case "reaction": party.receiveReaction(message); break;
    case "comment-reaction": chat.receiveCommentReaction(message); break;
    case "session-state": player.applySessionState(message); participants.setSourceOwner(message.sourceOwnerId); break;
    case "permissions-updated":
      participants.updated(message);
      if (message.clientId === state.clientId) player.applyPermissions(message.permissions);
      break;
    case "playback-rejected":
      player.rejectPlayback(message);
      chat.addSystemMessage(message.message);
      break;
    case "captions-updated": player.updateCaptions(message); break;
    case "compatibility-ready": player.applyCompatibility(message); break;
    case "transcode-info": player.updateEncoder(message.encoder); break;
    case "media-error": player.showMediaError(message.message); break;
    case "chat": chat.receive(message); break;
    case "name-updated":
    case "name-rejected": chat.handleNameMessage(message); break;
    case "host-left":
      if (!message.preserveMedia) player.showNoVideo("Host disconnected");
      chat.addSystemMessage(message.hostId ? "The host left. A new host has taken over." : "The host left. Waiting for a new host...");
      break;
    case "room-blocked": showBlocked(); break;
    case "participant-action-complete": participants.complete(message); break;
    case "error":
      if (["set-viewer-permissions", "block-participant", "unblock-participant", "transfer-host"].includes(message.action)) participants.fail(message);
      chat.addSystemMessage(message.message); break;
  }
}

function showBlocked() {
  admissionBlocked = true; publicConnectionStarted = false;
  connection.dispose(); files.disconnect(); participants.setConnected(false);
  player.showNoVideo("Blocked from room");
  setConnectionStatus(elements, false, "Blocked from room");
  if (roomId) { location.href = "/?blocked=1"; return; }
  elements.roomEntry.hidden = false; elements.roomEntryChoices.hidden = false;
  elements.createRoomForm.hidden = true; elements.joinRoomForm.hidden = true; elements.roomEntrySuccess.hidden = true;
  elements.initialDisplayNameField.hidden = false; elements.continuePublicRoom.hidden = false;
  elements.roomEntryStatus.textContent = blockedText;
}

function applyParticipantPermissions(participants = []) {
  const current = participants.find(person => person.clientId === state.clientId);
  if (current?.permissions) player.applyPermissions(current.permissions);
}

if (roomEntryPending) {
  if (admissionBlocked || new URLSearchParams(location.search || "").has("blocked")) elements.roomEntryStatus.textContent = blockedText;
  elements.continuePublicRoom.addEventListener("click", () => {
    if (publicConnectionStarted) return;
    if (admissionBlocked) {
      elements.roomEntry.hidden = false;
      fetch("/api/session").then(response => {
        if (!response.ok) { elements.roomEntryStatus.textContent = blockedText; return; }
        admissionBlocked = false; publicConnectionStarted = true; elements.roomEntry.hidden = true;
        connection.resume();
      }).catch(() => { elements.roomEntryStatus.textContent = "Could not reconnect. Try again."; });
      return;
    }
    publicConnectionStarted = true;
    connection.connect();
  });
} else {
  connection.connect();
}
