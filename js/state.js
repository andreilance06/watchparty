import { createClientId } from "./utils/client-id.js";

export function createClientState() {
  const clientId = createClientId();
  const fallbackName = `Guest-${clientId.slice(0, 4).toUpperCase()}`;
  let clientName = fallbackName;
  try {
    clientName = localStorage.getItem("watchparty-display-name")?.trim().slice(0, 24) || fallbackName;
  } catch {}

  return {
    clientId, clientName, guestName: fallbackName, role: "viewer",
    activeMediaUrl: "", activeEncoder: "",
    suppressVideoEvents: false, latestHostPaused: true
  };
}
