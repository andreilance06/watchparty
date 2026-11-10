export function initializeRoomControls(elements, { roomId, room, onLeave }) {
  const { roomInfo, roomInfoName, roomInfoToggle, roomInfoDetails, roomInfoLink,
    copyCurrentRoomLink, roomInfoStatus, roomActionButton, roomActionStatus } = elements;
  roomInfo.hidden = false;
  roomInfoName.textContent = room.name;
  const invitePath = room.invitePath || `/?room=${encodeURIComponent(roomId || "default")}`;
  roomInfoLink.textContent = new URL(invitePath, `${location.protocol}//${location.host}`).href;
  roomInfoToggle.addEventListener("click", () => {
    const expanded = roomInfoToggle.getAttribute("aria-expanded") === "true";
    roomInfoToggle.setAttribute("aria-expanded", String(!expanded));
    roomInfoDetails.hidden = expanded;
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || roomInfoDetails.hidden) return;
    roomInfoDetails.hidden = true;
    roomInfoToggle.setAttribute("aria-expanded", "false");
    roomInfoToggle.focus();
  });
  copyCurrentRoomLink.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(roomInfoLink.textContent);
      roomInfoStatus.textContent = "Invitation link copied.";
    } catch { roomInfoStatus.textContent = "Select the invitation link to copy it."; }
  });
  roomActionButton.textContent = "Leave room";
  roomActionButton.addEventListener("click", async () => {
    if (roomActionButton.disabled) return;
    roomActionButton.disabled = true;
    roomActionStatus.textContent = "Leaving room…";
    try {
      if (roomId) {
        const response = await fetch(`/rooms/${encodeURIComponent(roomId)}/api/leave`, { method: "POST" });
        const result = await response.json();
        if (!response.ok || result.left !== true) throw new Error(result.error || "Could not leave the room.");
      }
      onLeave();
      location.href = "/";
    } catch (error) {
      roomActionStatus.textContent = error.message;
      roomActionButton.disabled = false;
    }
  });
}
