import { PERMISSION_CATALOG, DEFAULT_PERMISSIONS } from "./permissions.js";
import { createClientId } from "./utils/client-id.js";

export function createRoomPermissions({ elements, state, send }) {
  const { viewerPermissionsButton: button, viewerPermissionsDialog: dialog, roomPermissionFields: fields,
    roomPermissionStatus: status, closeViewerPermissions: closeButton } = elements;
  let defaults = { ...DEFAULT_PERMISSIONS }, connected = false, pending = null;
  const inputs = new Map();
  let group;
  for (const item of PERMISSION_CATALOG) {
    if (group !== item.group) {
      const title = document.createElement("h3"); title.className = "permission-group"; title.textContent = item.group;
      fields.appendChild(title); group = item.group;
    }
    const label = document.createElement("label"); label.className = "permission-switch";
    const text = document.createElement("span"); text.textContent = item.label;
    const input = document.createElement("input"); input.type = "checkbox"; input.dataset.permission = item.key;
    input.setAttribute("aria-label", `${item.label} by default`);
    input.addEventListener("change", () => {
      const value = input.checked; refresh();
      if (pending || !connected || state.role !== "host") return;
      const requestId = createClientId();
      pending = { requestId, timer: setTimeout(() => finish("The request timed out. Try again."), 10000) };
      status.textContent = "Updating..."; refresh();
      if (send({ type: "set-room-permissions", requestId, permissions: { [item.key]: value } }) === false) finish("Reconnect before updating permissions.");
    });
    label.append(text, input); fields.appendChild(label); inputs.set(item.key, input);
  }
  function close() { dialog.close?.(); button.focus(); }
  button.addEventListener("click", () => { if (connected && state.role === "host") dialog.showModal?.(); });
  closeButton.addEventListener("click", close);
  function refresh() {
    elements.roomSettingsSection.hidden = state.role !== "host";
    button.hidden = state.role !== "host"; button.disabled = !connected;
    for (const [key, input] of inputs) { input.checked = defaults[key]; input.disabled = !connected || state.role !== "host" || Boolean(pending); }
    if (state.role !== "host" && dialog.open) close();
  }
  function finish(message) { clearTimeout(pending?.timer); pending = null; status.textContent = message; refresh(); }
  return {
    refresh,
    setConnected(value) { connected = value; if (!value) finish("Reconnect before updating permissions."); refresh(); },
    receive(message) {
      if (message.roomPermissions) defaults = { ...DEFAULT_PERMISSIONS, ...message.roomPermissions };
      if (pending && pending.requestId === message.requestId) finish(message.type === "error" ? message.message : "Room defaults updated.");
      refresh();
    }
  };
}
