import { initializeTheme } from "./theme.js";
import { createClientState } from "./state.js";

export function initializeHub(root = document) {
  const el = id => root.querySelector(`#${id}`);
  const state = createClientState();
  initializeTheme(el("themeToggle"));
  el("initialDisplayName").value = state.clientName === state.guestName ? "" : state.clientName;
  const cards = new Map();
  let rooms = new Map(), refreshing = false, disposed = false, selected = null;
  let identityPromise, busy = false, invitationHandled = false, listController;
  const invitation = new URLSearchParams(location.search).get("room");
  function notice(message) {
    el("hubNotice").textContent = message;
    el("hubNotice").hidden = !message;
  }
  if (new URLSearchParams(location.search).has("blocked")) notice("You are blocked from that room until a host unblocks you.");
  function payload(fields) {
    return { ...fields, displayName: el("initialDisplayName").value.replace(/\s+/g, " ").trim().slice(0, 24) || state.guestName };
  }
  async function identity() {
    if (!identityPromise) identityPromise = fetch("/api/viewer-identity", { method: "POST" }).then(response => {
      if (!response.ok) throw new Error("Could not establish your browser identity. Try again.");
    }).catch(error => { identityPromise = null; throw error; });
    await identityPromise;
  }
  async function enter(path, fields) {
    await identity();
    const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload(fields)) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not enter the room.");
    if (typeof result.room?.watchPath !== "string" || !/^\/watch(?:\?|$)/.test(result.room.watchPath)) throw new Error("The server returned an invalid room response.");
    try { localStorage.setItem("watchparty-display-name", payload({}).displayName); } catch {}
    location.href = result.room.watchPath;
  }
  function clearInvitation() {
    if (invitation) {
      const params = new URLSearchParams(location.search);
      params.delete("room");
      globalThis.history?.replaceState(null, "", params.size ? `/?${params}` : "/");
    }
  }
  async function chooseRoom(room) {
    if (busy) return;
    busy = true;
    const card = cards.get(room.id);
    if (card) card.button.disabled = true;
    notice("");
    try {
      if (room.passwordRequired) {
        const response = await fetch(`/rooms/${encodeURIComponent(room.id)}/api/session`);
        if (response.ok) { location.href = room.watchPath; return; }
        if (response.status !== 401) {
          const result = await response.json();
          throw new Error(result.error || "Could not enter the room.");
        }
        selected = room.id;
        el("joinRoomTitle").textContent = `Join ${room.name}`;
        el("joinRoomPassword").value = "";
        el("joinRoomStatus").textContent = "";
        el("submitJoinRoom").disabled = false;
        el("joinRoomDialog").showModal();
      } else {
        await enter("/api/rooms/join", { roomId: room.id });
      }
    } catch (error) { notice(error.message || "Could not enter the room. Try again."); }
    finally { busy = false; if (card) card.button.disabled = false; }
  }
  function node(tag, className, text) {
    const result = document.createElement(tag);
    result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  }
  function updateCard(room) {
    let card = cards.get(room.id);
    if (!card) {
      const article = node("article", "room-card");
      const preview = node("div", "room-preview");
      const image = node("img", ""); image.alt = ""; image.loading = "lazy"; image.decoding = "async"; image.hidden = true;
      const placeholder = node("div", "room-placeholder");
      const placeholderLabel = node("span", "");
      placeholder.append(node("span", "room-placeholder-icon", "▶"), placeholderLabel);
      const badge = node("span", "room-badge");
      preview.append(image, placeholder, badge);
      const body = node("div", "room-card-body"), title = node("h3", ""), file = node("p", "room-file");
      const footer = node("div", "room-card-footer"), participants = node("span", "room-participants");
      const button = node("button", "hub-button hub-primary", "Join room"); button.type = "button";
      button.addEventListener("click", () => { const current = rooms.get(room.id); if (current) void chooseRoom(current); });
      image.addEventListener("load", () => { image.hidden = false; placeholder.hidden = true; });
      image.addEventListener("error", () => { image.hidden = true; placeholder.hidden = false; });
      footer.append(participants, button); body.append(title, file, footer); article.append(preview, body);
      el("roomGrid").append(article);
      card = { article, image, placeholder, placeholderLabel, badge, title, file, participants, button, thumbnailUrl: null };
      cards.set(room.id, card);
    }
    card.title.textContent = room.name;
    card.file.textContent = room.fileName || "No video selected";
    card.file.title = room.fileName || "No video selected";
    card.participants.textContent = `${room.participantCount} online`;
    card.badge.textContent = room.passwordRequired ? "Password protected" : room.id === "default" ? "Public room" : "Open room";
    card.placeholderLabel.textContent = room.fileName ? "Preview unavailable" : "Waiting for a video";
    card.button.setAttribute("aria-label", `Join ${room.name}`);
    if (room.thumbnailUrl !== card.thumbnailUrl) {
      card.thumbnailUrl = room.thumbnailUrl;
      if (room.thumbnailUrl) { card.image.hidden = false; card.image.src = room.thumbnailUrl; }
      else { card.image.removeAttribute("src"); card.image.hidden = true; card.placeholder.hidden = false; }
    }
  }
  async function refresh() {
    if (refreshing || document.hidden || disposed) return;
    refreshing = true;
    listController = new AbortController();
    const timeout = setTimeout(() => listController?.abort(), 10000);
    try {
      const response = await fetch("/api/rooms", { signal: listController.signal });
      const result = await response.json();
      if (!response.ok || !Array.isArray(result.rooms)) throw new Error(result.error || "Could not load rooms.");
      if (disposed) return;
      rooms = new Map(result.rooms.map(room => [room.id, room]));
      for (const room of rooms.values()) updateCard(room);
      for (const [id, card] of cards) if (!rooms.has(id)) { card.article.remove(); cards.delete(id); }
      el("roomCount").textContent = String(rooms.size);
      el("hubStatus").textContent = rooms.size ? "" : "No rooms yet. Create a room to start watching.";
      el("retryRooms").hidden = true;
      if (selected && !rooms.has(selected)) {
        el("joinRoomStatus").textContent = "This room is no longer available.";
        el("submitJoinRoom").disabled = true;
      }
      if (invitation && !invitationHandled) {
        invitationHandled = true;
        const room = rooms.get(invitation);
        clearInvitation();
        if (room) void chooseRoom(room);
        else notice("That room is no longer available. Choose another room or create your own.");
      }
    } catch (error) {
      if (!disposed) {
        el("hubStatus").textContent = "Could not refresh rooms. Check your connection and try again.";
        el("retryRooms").hidden = false;
      }
    } finally { clearTimeout(timeout); listController = null; refreshing = false; el("roomGrid").setAttribute("aria-busy", "false"); }
  }
  el("retryRooms").addEventListener("click", refresh);
  el("createRoomButton").addEventListener("click", () => {
    if (busy) return;
    el("createRoomStatus").textContent = "";
    el("createRoomDialog").showModal();
  });
  for (const [button, dialog] of [["cancelCreateRoom", "createRoomDialog"], ["cancelJoinRoom", "joinRoomDialog"]]) {
    el(button).addEventListener("click", () => { if (!busy) el(dialog).close(); });
    el(dialog).addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  }
  el("joinRoomDialog").addEventListener("close", () => { el("joinRoomPassword").value = ""; selected = null; });
  el("createRoomDialog").addEventListener("close", () => { el("createRoomPassword").value = ""; });
  async function submit(event, creating) {
    event.preventDefault();
    if (busy) return;
    const targetId = selected;
    const status = el(creating ? "createRoomStatus" : "joinRoomStatus");
    if (!creating && !rooms.has(targetId)) { status.textContent = "This room is no longer available."; return; }
    const name = el("createRoomName").value.trim();
    if (creating && !name) { status.textContent = "Enter a room name."; return; }
    busy = true;
    const button = el(creating ? "submitCreateRoom" : "submitJoinRoom");
    button.disabled = true;
    status.textContent = "Entering your room…";
    try {
      const password = el(creating ? "createRoomPassword" : "joinRoomPassword").value;
      await enter(creating ? "/api/rooms" : "/api/rooms/join", { ...(creating ? { name } : { roomId: targetId }), ...(password ? { password } : {}) });
    } catch (error) { status.textContent = error.message || "Could not enter the room. Try again."; }
    finally { busy = false; button.disabled = !creating && !rooms.has(targetId); }
  }
  el("createRoomForm").addEventListener("submit", event => void submit(event, true));
  el("joinRoomForm").addEventListener("submit", event => void submit(event, false));
  const timer = setInterval(refresh, 5000);
  const onVisible = () => { if (!document.hidden) void refresh(); };
  document.addEventListener("visibilitychange", onVisible);
  function dispose() {
    disposed = true; clearInterval(timer); listController?.abort();
    document.removeEventListener("visibilitychange", onVisible);
  }
  window.addEventListener("pagehide", dispose);
  // Restore polling when returning from a player page through the back-forward cache.
  window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
  void refresh();
  return { refresh, dispose };
}

export const hub = initializeHub();
