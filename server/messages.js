const { randomUUID } = require("crypto");
const { sanitizeDisplayName, createNameRegistry } = require("./names");
const { currentTime, sessionState } = require("./state");

const MAX_VIDEO_SUGGESTIONS = 30;

function isSingleEmoji(value) {
  if (typeof value !== "string" || !value || [...value].length > 16) return false;
  const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)];
  if (segments.length !== 1) return false;
  const hasEmoji = /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u.test(value) ||
    /^[\u{1F1E6}-\u{1F1FF}]{2}$/u.test(value) ||
    /^[#*0-9]\uFE0F?\u20E3$/u.test(value);
  return hasEmoji && /^[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\uFE0F\u200D\u{1F1E6}-\u{1F1FF}\u20E3#*0-9]+$/u.test(value);
}

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

  function commentReactionMessage(commentId, reactions = state.commentReactions.get(commentId) || new Map()) {
    return {
      type: "comment-reaction", commentId,
      reactions: [...reactions].map(([clientId, reaction]) => ({
        clientId, name: reaction.name, emoji: reaction.emoji
      }))
    };
  }

  function broadcastCommentReactions(commentId) {
    broadcast(commentReactionMessage(commentId));
  }

  function handleMessage(ws, message) {
    const client = state.clients.get(ws.clientId);
    if (!client) return;
    switch (message.type) {
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
          for (const [commentId, reactions] of state.commentReactions) {
            if (reactions.size) send(ws, commentReactionMessage(commentId, reactions));
          }
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
        const commentId = randomUUID();
        state.commentReactions.set(commentId, new Map());
        broadcast({ type: "chat", commentId, clientId: ws.clientId, name: client.name || "Guest", message: text,
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
        break;
      }
      case "comment-reaction": {
        if (typeof message.commentId !== "string" || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(message.commentId) ||
            !state.commentReactions.has(message.commentId) ||
            (message.emoji !== null && !isSingleEmoji(message.emoji))) {
          send(ws, { type: "error", message: "That comment reaction is not supported." });
          break;
        }
        const reactions = state.commentReactions.get(message.commentId);
        if (message.emoji === null) reactions.delete(ws.clientId);
        else reactions.set(ws.clientId, { name: client.name || "Guest", emoji: message.emoji });
        broadcastCommentReactions(message.commentId);
        break;
      }
      case "reaction": {
        if (!isSingleEmoji(message.emoji)) {
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
        const viewerPlayPause = client.role === "viewer" && (syncMode === "play" || syncMode === "pause");
        if (client.role !== "host" && !viewerPlayPause) return;
        const wasPaused = state.playback.paused;
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
        if ((!wasPaused && state.playback.paused) || syncMode === "seek") media.cancelSegmentJobs(false);
        // Echo viewer play/pause back to its sender so its local shared-state
        // flag is updated too. Host-originated state already matches locally.
        broadcast(sessionState(state, syncMode), viewerPlayPause ? null : ws.clientId);
        break;
      }
    }
  }

  return { handleMessage, updatePresence, updatePartyState };
}

module.exports = { createMessageHandler };
