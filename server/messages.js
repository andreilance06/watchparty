const { randomUUID } = require("crypto");
const { sanitizeDisplayName, createNameRegistry } = require("./names");
const { currentTime, sessionState } = require("./state");
const { permissionKey, permissionsFor, promoteHost } = require("./permissions");
const { participants: roomParticipants } = require("./participants");

const MAX_VIDEO_SUGGESTIONS = 30;
const MAX_COMMENTS = 500;
const emojiSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function isSingleEmoji(value) {
  if (typeof value !== "string" || !value || [...value].length > 16) return false;
  const segments = [...emojiSegmenter.segment(value)];
  if (segments.length !== 1) return false;
  const hasEmoji = /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u.test(value) ||
    /^[\u{1F1E6}-\u{1F1FF}]{2}$/u.test(value) ||
    /^[#*0-9]\uFE0F?\u20E3$/u.test(value);
  return hasEmoji && /^[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\uFE0F\u200D\u{1F1E6}-\u{1F1FF}\u20E3#*0-9]+$/u.test(value);
}

function normalizeMovieSelection(movie) {
  if (!movie || typeof movie !== "object" || Array.isArray(movie) ||
      typeof movie.title !== "string" || typeof movie.pageUrl !== "string") return null;
  let pageUrl;
  try { pageUrl = new URL(movie.pageUrl); } catch { return null; }
  if (pageUrl.protocol !== "https:" || pageUrl.hostname !== "en.wikipedia.org" ||
      !pageUrl.pathname.startsWith("/wiki/") || pageUrl.username || pageUrl.password) return null;

  let posterUrl = null;
  if (movie.posterUrl != null) {
    if (typeof movie.posterUrl !== "string") return null;
    try {
      const imageUrl = new URL(movie.posterUrl);
      if (imageUrl.protocol !== "https:" ||
          !["upload.wikimedia.org", "thumb.wikimedia.org"].includes(imageUrl.hostname) ||
          !imageUrl.pathname.startsWith("/wikipedia/") ||
          imageUrl.username || imageUrl.password) return null;
      posterUrl = imageUrl.href;
    } catch { return null; }
  }
  const description = typeof movie.description === "string"
    ? movie.description.replace(/\s+/g, " ").trim().slice(0, 200)
    : "";
  return {
    pageUrl: pageUrl.href,
    posterUrl,
    description
  };
}

function createMessageHandler({ state, transport, media, movieSearch }) {
  const { send, broadcast } = transport;
  const { isDisplayNameTaken } = createNameRegistry(state.clients);

  function participants() {
    return roomParticipants(state);
  }

  function updatePartyState() {
    const suggestions = state.videoSuggestions.map((suggestion) => ({
      ...suggestion,
      ownerName: state.clients.get(suggestion.ownerId)?.name || suggestion.ownerName || "Former participant",
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
          const requestedName = client.hasMemberName ? client.name : sanitizeDisplayName(message.name, client.name);
          const nameRejected = isDisplayNameTaken(requestedName, ws.clientId);
          if (!nameRejected) client.name = requestedName;
          if (!state.hostId) promoteHost(state, ws.clientId);
          send(ws, {
            type: "role", role: client.role, hostId: state.hostId, clientId: ws.clientId,
            viewerCount: state.clients.size, name: client.name,
            permissions: permissionsFor(state, client, ws.clientId),
            ...(nameRejected ? { nameRejected: requestedName } : {})
          });
          send(ws, sessionState(state, "join"));
          for (const [commentId, reactions] of state.commentReactions) {
            if (reactions.size) send(ws, commentReactionMessage(commentId, reactions));
          }
          updatePresence();
        }
        break;
      case "set-viewer-permissions": {
        const target = state.clients.get(message.clientId);
        const value = message.permissions;
        if (client.role !== "host" || state.hostId !== ws.clientId || !target || target.role !== "viewer" ||
            !value || typeof value !== "object" || Array.isArray(value) ||
            Object.keys(value).length !== 3 ||
            !["playPause", "seek", "playbackRate"].every(key => typeof value[key] === "boolean")) {
          send(ws, { type: "error", action: message.type, clientId: message.clientId, requestId: message.requestId,
            message: "Only the room host can set valid permissions for a connected viewer." });
          break;
        }
        const key = permissionKey(target, message.clientId);
        state.viewerPermissions.set(key, { playPause: value.playPause, seek: value.seek, playbackRate: value.playbackRate });
        for (const [clientId, affected] of state.clients) {
          if (permissionKey(affected, clientId) === key) {
            broadcast({ type: "permissions-updated", clientId, ...(message.requestId ? { requestId: message.requestId } : {}), permissions: permissionsFor(state, affected, clientId) });
          }
        }
        updatePartyState();
        break;
      }
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
        while (state.commentReactions.size > MAX_COMMENTS) state.commentReactions.delete(state.commentReactions.keys().next().value);
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
        const movie = message.movie === undefined ? null : normalizeMovieSelection(message.movie);
        const knownMovie = movie && Number.isSafeInteger(message.movie.pageId)
          ? movieSearch?.getSelection(message.movie.pageId)
          : null;
        if (message.movie !== undefined && (!movie || !knownMovie || message.movie.title !== title ||
            knownMovie.title !== title || knownMovie.pageUrl !== movie.pageUrl ||
            knownMovie.posterUrl !== movie.posterUrl || knownMovie.description !== movie.description)) {
          send(ws, { type: "error", message: "That movie selection is not supported." });
          break;
        }
        const existing = state.videoSuggestions.find(
          (suggestion) => suggestion.title.toLocaleLowerCase() === title.toLocaleLowerCase()
        );
        let suggestion = existing;
        if (existing) {
          if (!existing.movie && movie) existing.movie = movie;
        } else {
          if (state.videoSuggestions.length >= MAX_VIDEO_SUGGESTIONS) {
            send(ws, { type: "error", message: "The next-video suggestion list is full." });
            break;
          }
          suggestion = {
            id: state.nextSuggestionId++,
            title,
            ownerId: ws.clientId,
            ownerName: client.name || "Guest",
            ...(movie ? { movie } : {})
          };
          state.videoSuggestions.push(suggestion);
        }
        state.videoVotes.set(ws.clientId, suggestion.id);
        updatePartyState();
        break;
      }
      case "remove-video-suggestion": {
        const suggestionId = Number(message.suggestionId);
        const index = state.videoSuggestions.findIndex((suggestion) => suggestion.id === suggestionId);
        if (!Number.isInteger(suggestionId) || index < 0) {
          send(ws, { type: "error", message: "That video suggestion is no longer available." });
          break;
        }
        if (state.videoSuggestions[index].ownerId !== ws.clientId) {
          send(ws, { type: "error", message: "You can only remove your own video suggestions." });
          break;
        }
        state.videoSuggestions.splice(index, 1);
        for (const [clientId, voteId] of state.videoVotes) {
          if (voteId === suggestionId) state.videoVotes.delete(clientId);
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
        const viewerCommand = client.role !== "host";
        const permission = ({ play: "playPause", pause: "playPause", seek: "seek", rate: "playbackRate" })[syncMode];
        if (viewerCommand && (!permission || !permissionsFor(state, client, ws.clientId)[permission])) {
          send(ws, { type: "playback-rejected", commandSequence: message.commandSequence,
            message: "The host has not enabled that playback control for you.", state: sessionState(state, "correction") });
          return;
        }
        if (message.commandSequence !== undefined) {
          if (!Number.isSafeInteger(message.commandSequence) || message.commandSequence <= (client.lastPlaybackCommand || 0)) return;
          client.lastPlaybackCommand = message.commandSequence;
        }
        // A seek establishes a new clock epoch. Old timer ticks must not undo it.
        if (syncMode !== "seek" && message.playbackRevision !== undefined && message.playbackRevision !== state.playbackRevision) return;
        const viewerPlayPause = viewerCommand && (syncMode === "play" || syncMode === "pause");
        if (viewerCommand) {
          const sharedTime = currentTime(state);
          const reportedTime = Math.min(state.mediaDuration, Math.max(0, Number(message.time) || 0));
          const acceptedTime = Math.abs(reportedTime - sharedTime) <= 2 ? reportedTime : sharedTime;
          state.playback = {
            paused: viewerPlayPause ? syncMode === "pause" : state.playback.paused,
            time: syncMode === "seek" ? reportedTime : viewerPlayPause ? acceptedTime : sharedTime,
            rate: syncMode === "rate" ? Math.min(4, Math.max(0.25, Number(message.playbackRate) || 1)) : state.playback.rate,
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
        broadcast({ ...sessionState(state, syncMode), ...(syncMode === "seek" ? { seekSequence: message.commandSequence, commandClientId: ws.clientId } : {}) },
          viewerCommand || syncMode === "seek" ? null : ws.clientId);
        break;
      }
    }
  }

  return { handleMessage, updatePresence, updatePartyState };
}

module.exports = { createMessageHandler };
