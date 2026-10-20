import { DEFAULT_PERMISSIONS } from "./permissions.js";
import { createClientId } from "./utils/client-id.js";

export function createParticipants({ elements, state, send }) {
  const { participantList, participantDropdown, participantDetails, participantStatus } = elements;
  let people = [], selected = null, connected = false, trigger = null, signature = "", detailSignature = "", pending = null;
  const buttons = new Map();
  function close(restoreFocus = false) {
    participantDropdown.hidden = true;
    trigger?.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger?.focus();
    selected = null; trigger = null; detailSignature = "";
    document.removeEventListener("pointerdown", dismissOutside); document.removeEventListener("keydown", dismissEscape);
  }
  function position() {
    if (participantDropdown.hidden || !trigger?.isConnected) return;
    const anchor = trigger.getBoundingClientRect(), box = participantDropdown.getBoundingClientRect();
    const width = Math.min(288, window.innerWidth - 16);
    participantDropdown.style.width = `${width}px`;
    participantDropdown.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))}px`;
    const height = Math.min(box.height, window.innerHeight - 16);
    const preferred = window.innerHeight - anchor.bottom - 16 >= height ? anchor.bottom + 6 : anchor.top - height - 6;
    const top = Math.max(8, Math.min(preferred, window.innerHeight - height - 8));
    participantDropdown.style.top = `${top}px`;
    participantDropdown.style.maxHeight = `${Math.max(0, window.innerHeight - top - 8)}px`;
  }
  function finish(message) {
    if (pending && message.requestId && message.requestId !== pending.id) return;
    const focus = pending?.focus;
    clearTimeout(pending?.timer); pending = null;
    participantStatus.textContent = message.message || "Updated.";
    renderDetails(focus);
  }
  function request(type, person, permissions, focus) {
    if (pending || !connected || state.role !== "host") return;
    const id = createClientId();
    pending = { id, clientId: person.clientId, focus,
      timer: setTimeout(() => finish({ message: "The request timed out. Try again." }), 10000) };
    participantStatus.textContent = "Updating…";
    renderDetails();
    if (send({ type, clientId: person.clientId, requestId: id, ...(permissions ? { permissions } : {}) }) === false) finish({ message: "Reconnect before managing participants." });
  }
  function renderDetails(focus) {
    const person = people.find(item => item.clientId === selected);
    if (!person) { close(); return; }
    const next = JSON.stringify([person, state.role, connected, pending?.id]);
    if (next === detailSignature && !focus) { position(); return; }
    detailSignature = next; participantDetails.replaceChildren();
    const heading = document.createElement("h3"); heading.textContent = person.name; heading.id = "participantDropdownTitle";
    const status = document.createElement("p"); status.className = "participant-detail-role";
    status.textContent = person.blocked ? "Blocked" : person.role === "host" ? "Host" : "Viewer";
    participantDetails.append(heading, status);
    if (person.suppliesVideo) {
      const provider = document.createElement("p"); provider.className = "participant-provider";
      provider.textContent = "Sharing the current video. This browser must stay connected.";
      participantDetails.appendChild(provider);
    }
    const editable = connected && state.role === "host" && person.role !== "host" && !person.blocked;
    const permissions = person.permissions || DEFAULT_PERMISSIONS;
    for (const [key, title] of [["playPause", "Play/pause"], ["seek", "Seek"], ["playbackRate", "Playback speed"]]) {
      const label = document.createElement("label"); label.className = "permission-switch";
      const input = document.createElement("input"); input.type = "checkbox"; input.checked = permissions[key]; input.dataset.permission = key;
      input.disabled = !editable || Boolean(pending); input.setAttribute("aria-label", `${title} for ${person.name}`);
      input.addEventListener("change", () => {
        const next = { ...permissions, [key]: !permissions[key] }; input.checked = permissions[key];
        if (editable) request("set-viewer-permissions", person, next, key);
      });
      const text = document.createElement("span"); text.textContent = title;
      label.append(text, input); participantDetails.appendChild(label);
      if (focus === key && !input.disabled) queueMicrotask(() => input.focus());
    }
    if (connected && state.role === "host" && person.role !== "host") {
      const actions = document.createElement("div"); actions.className = "participant-actions";
      const addAction = (title, type, danger = false) => {
        const button = document.createElement("button"); button.type = "button"; button.textContent = title;
        button.disabled = Boolean(pending); button.dataset.action = type;
        if (danger) button.className = "participant-danger";
        button.addEventListener("click", () => request(type, person)); actions.appendChild(button);
      };
      if (person.blocked) addAction("Unblock", "unblock-participant");
      else {
        addAction("Transfer host", "transfer-host"); addAction("Kick and block", "block-participant", true);
        if (person.suppliesVideo) {
          const warning = document.createElement("p"); warning.className = "participant-action-warning";
          warning.textContent = "Blocking this viewer stops the current video."; actions.appendChild(warning);
        }
      }
      participantDetails.appendChild(actions);
    }
    position();
  }
  function renderList() {
    const next = JSON.stringify(people);
    if (next === signature) return;
    signature = next;
    const seen = new Set();
    for (const person of people) {
      seen.add(person.clientId);
      let button = buttons.get(person.clientId);
      if (!button) {
        const item = document.createElement("li"); item.className = "participant-item";
        button = document.createElement("button"); button.type = "button"; button.dataset.clientId = person.clientId;
        button.setAttribute("aria-controls", "participantDropdown"); button.setAttribute("aria-expanded", "false");
        button.addEventListener("click", () => {
          if (selected === person.clientId) { close(); return; }
          close(); selected = person.clientId; trigger = button; participantStatus.textContent = "";
          participantDropdown.hidden = false; document.body.appendChild(participantDropdown);
          button.setAttribute("aria-expanded", "true"); renderDetails();
          document.addEventListener("pointerdown", dismissOutside); document.addEventListener("keydown", dismissEscape);
        });
        item.appendChild(button); participantList.appendChild(item); buttons.set(person.clientId, button);
      }
      button.className = `participant${person.blocked ? " participant-blocked" : ""}`; button.replaceChildren();
      const indicator = document.createElement("span"); indicator.className = `participant-status ${person.blocked ? "offline" : "online"}`;
      indicator.setAttribute("aria-label", person.blocked ? "Blocked" : "Connected");
      const name = document.createElement("span"); name.className = "participant-name"; name.textContent = person.name;
      const role = document.createElement("span"); role.className = "participant-role";
      role.textContent = person.blocked ? "Blocked" : person.role === "host" ? "Host" : "Viewer";
      button.append(indicator, name, role);
    }
    for (const [id, button] of buttons) if (!seen.has(id)) { if (selected === id) close(); button.parentNode.remove(); buttons.delete(id); }
    if (selected) renderDetails();
  }
  function dismissOutside(event) {
    if (participantDropdown.hidden) return;
    const path = event.composedPath?.() || [];
    if (!path.includes(participantDropdown) && !path.includes(trigger)) close();
  }
  function dismissEscape(event) { if (event.key === "Escape" && !participantDropdown.hidden) { event.preventDefault(); close(true); } }
  window.addEventListener("resize", position); window.addEventListener("scroll", position, true);
  participantDropdown.hidden = true;
  return {
    close, refresh: () => { if (selected) renderDetails(); },
    setConnected(value) { connected = value; if (!value) { clearTimeout(pending?.timer); pending = null; close(); } },
    updateParticipants(value = []) { people = value; renderList(); },
    setSourceOwner(clientId) { if (clientId === undefined) return; people = people.map(person => ({ ...person, suppliesVideo: !person.blocked && person.clientId === clientId })); renderList(); },
    updated(message) {
      const person = people.find(item => item.clientId === message.clientId);
      if (person) person.permissions = message.permissions;
      if (pending?.clientId === message.clientId && (!message.requestId || message.requestId === pending.id)) finish({ message: "Permissions updated." });
      else if (selected) renderDetails();
    },
    complete: message => finish({ ...message, message: "Updated." }), fail: finish
  };
}
