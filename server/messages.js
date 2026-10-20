const { sanitizeDisplayName, createNameRegistry } = require("./names");
const { currentTime, sessionState } = require("./state");

const ALLOWED_REACTIONS = new Set(["❤️", "😂", "😮", "👏", "😢"]);
const MAX_VIDEO_SUGGESTIONS = 30;

function createMessageHandler({ state, transport, media }) {
  const { send, broadcast } = transport;
  const { isDisplayNameTaken } = createNameRegistry(state.clients);

  function participants() {
    return [...state.clients].map(([clientId, client]) => ({
      clientId, name: client.name, role: client.role
    }));
  }

  function updatePartyState() {
    const suggestions = state.videoSuggestions.map((suggestion) => ({
      ...suggestion,
      votes: [...state.videoVotes.values()].filter((id) => id === suggestion.id).length
    }));
    for (const [clientId, client] of state.clients) {
      send(client.ws, {
        type: "party-state", participants: participants(), suggestions,
        myVoteId: state.videoVotes.get(clientId) ?? null
      });
    }
  }

  function updatePresence() {
    broadcast({ type: "presence", count: state.clients.size, participants: participants() });
    updatePartyState();
  }

  function handleMessage(ws, message) {
    const client = state.clients.get(ws.clientId);
    if (!client) return;
    switch (message.type) {
      case "compatibility-request": {
        if (!state.mediaReady || message.mediaVersion !== state.mediaVersion) {
          send(ws, { type: "error", requestId: message.requestId, message: "The video source changed." });
          break;
        }
        const snapshot = sessionState(state);
        send(ws, { type: "compatibility-ready", requestId: message.requestId, mediaVersion: state.mediaVersion,
          playbackRevision: state.playbackRevision, streamGeneration: state.streamGeneration,
          url: snapshot.compatibilityUrl, time: snapshot.time, paused: snapshot.paused, playbackRate: snapshot.playbackRate });
        break;
      }
      case "join":
        {
          const requestedName = sanitizeDisplayName(message.name, client.name);
          const nameRejected = isDisplayNameTaken(requestedName, ws.clientId);
          if (!nameRejected) client.name = requestedName;
          if (!state.hostId) { state.hostId = ws.clientId; client.role = "host"; }
          send(ws, {
            type: "role", role: client.role, hostId: state.hostId, clientId: ws.clientId,
            viewerCount: state.clients.size, name: client.name,
            ...(nameRejected ? { nameRejected: requestedName } : {})
          });
          send(ws, sessionState(state, "join"));
          updatePresence();
        }
        break;
      case "set-name": {
        const requestedName = sanitizeDisplayName(message.name, client.name);
        if (isDisplayNameTaken(requestedName, ws.clientId)) {
          send(ws, {
            type: "name-rejected", name: client.name, requested: requestedName,
            message: `The display name “${requestedName}” is already in use.`
          });
          break;
        }
        client.name = requestedName;
        send(ws, { type: "name-updated", name: client.name });
        updatePresence();
        break;
      }
      case "chat": {
        const text = String(message.message || "").trim().slice(0, 300);
        if (!text) return;
        broadcast({ type: "chat", clientId: ws.clientId, name: client.name || "Guest", message: text,
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
        break;
      }
      case "reaction": {
        if (!ALLOWED_REACTIONS.has(message.emoji)) {
          send(ws, { type: "error", message: "That emoji reaction is not supported." });
          break;
        }
        broadcast({ type: "reaction", clientId: ws.clientId, name: client.name, emoji: message.emoji });
        break;
      }
      case "suggest-video": {
        const title = String(message.title || "").replace(/\s+/g, " ").trim().slice(0, 100);
        if (!title) {
          send(ws, { type: "error", message: "Enter a video title to suggest." });
          break;
        }
        const existing = state.videoSuggestions.find(
          (suggestion) => suggestion.title.toLocaleLowerCase() === title.toLocaleLowerCase()
        );
        if (!existing) {
          if (state.videoSuggestions.length >= MAX_VIDEO_SUGGESTIONS) {
            send(ws, { type: "error", message: "The next-video suggestion list is full." });
            break;
          }
          state.videoSuggestions.push({ id: state.nextSuggestionId++, title });
        }
        updatePartyState();
        break;
      }
      case "vote-video": {
        const suggestionId = Number(message.suggestionId);
        if (!Number.isInteger(suggestionId) || !state.videoSuggestions.some((suggestion) => suggestion.id === suggestionId)) {
          send(ws, { type: "error", message: "That video suggestion is no longer available." });
          break;
        }
        state.videoVotes.set(ws.clientId, suggestionId);
        updatePartyState();
        break;
      }
      case "video-state": {
        const syncMode = String(message.syncMode || "tick");
        if (!state.mediaPath || !state.mediaReady) return;
        if (message.mediaVersion !== undefined && message.mediaVersion !== state.mediaVersion) return;
        if (message.commandSequence !== undefined) {
          if (!Number.isSafeInteger(message.commandSequence) || message.commandSequence <= (client.lastPlaybackCommand || 0)) return;
          client.lastPlaybackCommand = message.commandSequence;
        }
        // A seek establishes a new clock epoch. Old timer ticks must not undo it.
        if (syncMode !== "seek" && message.playbackRevision !== undefined && message.playbackRevision !== state.playbackRevision) return;
        const viewerPlayPause = client.role === "viewer" && (syncMode === "play" || syncMode === "pause");
        if (client.role !== "host" && !viewerPlayPause) return;
        if (viewerPlayPause) {
          const sharedTime = currentTime(state);
          const reportedTime = Math.min(state.mediaDuration, Math.max(0, Number(message.time) || 0));
          const acceptedTime = Math.abs(reportedTime - sharedTime) <= 2 ? reportedTime : sharedTime;
          state.playback = {
            paused: syncMode === "pause",
            time: acceptedTime,
            rate: state.playback.rate,
            updatedAt: Date.now()
          };
        } else {
          state.playback = {
            paused: Boolean(message.paused),
            time: Math.min(state.mediaDuration, Math.max(0, Number(message.time) || 0)),
            rate: Math.min(4, Math.max(0.25, Number(message.playbackRate) || 1)),
            updatedAt: Date.now()
          };
        }
        if (syncMode === "seek") {
          state.playbackRevision += 1;
          media.restartStream();
        }
        // Echo viewer play/pause back to its sender so its local shared-state
        // flag is updated too. Host-originated state already matches locally.
        broadcast({ ...sessionState(state, syncMode), ...(syncMode === "seek" ? { seekSequence: message.commandSequence } : {}) },
          viewerPlayPause || syncMode === "seek" ? null : ws.clientId);
        break;
      }
    }
  }

  return { handleMessage, updatePresence, updatePartyState };
}

module.exports = { createMessageHandler };
