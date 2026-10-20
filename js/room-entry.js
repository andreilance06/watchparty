export function initializeRoomEntry(elements, { guestName, onLeave = () => {} }) {
  const {
    roomEntry, roomEntryChoices, createRoomChoice, joinRoomChoice, initialDisplayName, initialDisplayNameField,
    createRoomForm, createRoomName, createRoomCode, createRoomPassword, createRoomBack,
    joinRoomForm, joinRoomCode, joinRoomPassword, joinRoomBack, continuePublicRoom,
    roomEntryStatus, roomEntrySuccess, createdRoomCode, copyRoomCode, roomInviteLink,
    enterCreatedRoom, roomActionButton, roomActionStatus,
    roomInfo, roomInfoToggle, roomInfoName, roomInfoDetails, roomInfoCode, copyCurrentRoomCode, roomInfoStatus
  } = elements;
  const params = new URLSearchParams(location.search || "");
  const roomId = params.get("roomId");
  let createdRoomPath = "";
  roomEntry.hidden = Boolean(roomId);
  function showRoomInfo(name, accessCode = "") {
    roomInfoName.textContent = name;
    roomInfoCode.textContent = accessCode || "No access code (public room)";
    copyCurrentRoomCode.hidden = !accessCode;
    roomInfoStatus.textContent = "";
    roomInfo.hidden = false;
  }

  roomInfoToggle.addEventListener("click", () => {
    const expanded = roomInfoToggle.getAttribute("aria-expanded") === "true";
    roomInfoToggle.setAttribute("aria-expanded", String(!expanded));
    roomInfoDetails.hidden = expanded;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || roomInfoDetails.hidden) return;
    roomInfoDetails.hidden = true;
    roomInfoToggle.setAttribute("aria-expanded", "false");
    roomInfoToggle.focus();
  });
  copyCurrentRoomCode.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(roomInfoCode.textContent);
      roomInfoStatus.textContent = "Access code copied.";
    } catch {
      roomInfoStatus.textContent = "Copy unavailable. Select the access code to copy it.";
    }
  });

  function showMode(mode) {
    const creating = mode === "create";
    roomEntryChoices.hidden = true;
    createRoomForm.hidden = !creating;
    joinRoomForm.hidden = creating;
    roomEntryStatus.textContent = "";
    (creating ? createRoomName : joinRoomCode).focus();
  }

  function returnToChoices() {
    createRoomForm.hidden = true;
    joinRoomForm.hidden = true;
    roomEntrySuccess.hidden = true;
    initialDisplayNameField.hidden = false;
    continuePublicRoom.hidden = false;
    roomEntryChoices.hidden = false;
    roomEntryStatus.textContent = "";
  }

  function openRoomEntry() {
    returnToChoices();
    roomEntry.hidden = false;
    createRoomChoice.focus();
  }

  function payload(fields) {
    const displayName = initialDisplayName.value.replace(/\s+/g, " ").trim().slice(0, 24) || guestName;
    return { ...fields, displayName };
  }

  async function submit(form, path, body) {
    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton) submitButton.disabled = true;
    roomEntryStatus.textContent = "Connecting to your room…";
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not connect to the room.");
      if (typeof result.room?.watchPath !== "string") throw new Error("The server returned an invalid room response.");
      if (path === "/api/rooms") {
        if (typeof result.room.accessCode !== "string" || typeof result.room.invitePath !== "string") {
          throw new Error("The server returned incomplete room invitation details.");
        }
        createdRoomPath = result.room.watchPath;
        roomEntryChoices.hidden = true;
        initialDisplayNameField.hidden = true;
        createRoomForm.hidden = true;
        joinRoomForm.hidden = true;
        continuePublicRoom.hidden = true;
        roomEntrySuccess.hidden = false;
        createdRoomCode.textContent = result.room.accessCode;
        roomInviteLink.href = result.room.invitePath;
        roomEntryStatus.textContent = "";
      } else {
        location.href = result.room.watchPath;
      }
    } catch (error) {
      roomEntryStatus.textContent = error.message || "Could not connect to the room.";
      if (submitButton) submitButton.disabled = false;
    }
  }

  createRoomChoice.addEventListener("click", () => showMode("create"));
  joinRoomChoice.addEventListener("click", () => showMode("join"));
  createRoomBack.addEventListener("click", returnToChoices);
  joinRoomBack.addEventListener("click", returnToChoices);
  continuePublicRoom.addEventListener("click", () => {
    roomEntry.hidden = true;
    showRoomInfo("Default room");
  });
  if (roomId) {
    roomActionButton.textContent = "Leave room / switch";
    roomActionButton.addEventListener("click", async () => {
      roomActionButton.disabled = true;
      roomActionStatus.textContent = "Leaving room…";
      try {
        const response = await fetch(`/rooms/${encodeURIComponent(roomId)}/api/leave`, { method: "POST" });
        const result = await response.json();
        if (!response.ok || result.left !== true) throw new Error(result.error || "Could not leave the room.");
        onLeave();
        location.href = "/";
      } catch (error) {
        roomActionStatus.textContent = error.message || "Could not leave the room.";
        roomActionButton.disabled = false;
      }
    });
  } else {
    roomActionButton.textContent = "Choose or create a room";
    roomActionButton.addEventListener("click", openRoomEntry);
  }
  createRoomForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = createRoomName.value.trim();
    if (!name) {
      roomEntryStatus.textContent = "Enter a room name.";
      return;
    }
    const fields = {
      name,
      ...(createRoomCode.value.trim() ? { accessCode: createRoomCode.value.trim() } : {}),
      ...(createRoomPassword.value ? { password: createRoomPassword.value } : {})
    };
    submit(createRoomForm, "/api/rooms", payload(fields));
  });
  joinRoomForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const accessCode = joinRoomCode.value.trim();
    if (!accessCode) {
      roomEntryStatus.textContent = "Enter a room access code.";
      return;
    }
    submit(joinRoomForm, "/api/rooms/join", payload({
      accessCode,
      ...(joinRoomPassword.value ? { password: joinRoomPassword.value } : {})
    }));
  });
  enterCreatedRoom.addEventListener("click", () => {
    if (createdRoomPath) location.href = createdRoomPath;
  });
  copyRoomCode.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(createdRoomCode.textContent);
      roomEntryStatus.textContent = "Access code copied.";
    } catch {
      roomEntryStatus.textContent = "Copy unavailable. Select the access code to copy it.";
    }
  });

  const invitationCode = params.get("room");
  if (invitationCode) {
    joinRoomCode.value = invitationCode;
    showMode("join");
  } else {
    if (!roomId) roomEntry.hidden = false;
  }
  return !roomId;
}
