export function createChat({ elements, state: session, send }) {
  const { chatMessages, chatForm, chatInput, nameForm, displayNameInput } = elements;
  displayNameInput.value = session.clientName;

  function addSystemMessage(message) {
    const element = document.createElement("div");
    element.className = "system-message";
    element.textContent = message;
    chatMessages.appendChild(element);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
  
  function addChatMessage({ name, message, time, self }) {
    const article = document.createElement("article");
    article.className = `chat-message${self ? " self" : ""}`;
    const meta = document.createElement("div"); meta.className = "meta";
    const who = document.createElement("span"); who.className = "name"; who.textContent = name;
    const when = document.createElement("time"); when.textContent = time;
    const text = document.createElement("p"); text.textContent = message;
    meta.append(who, when); article.append(meta, text); chatMessages.appendChild(article);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function acceptName(name, invalid = false) {
    session.clientName = name;
    displayNameInput.value = name;
    if (invalid) displayNameInput.setAttribute("aria-invalid", "true");
    else displayNameInput.removeAttribute("aria-invalid");
    try { localStorage.setItem("watchparty-display-name", name); } catch {}
  }

  function receive(message) {
    addChatMessage({ ...message, self: message.clientId === session.clientId });
  }

  function handleNameMessage(message) {
    acceptName(message.name, message.type === "name-rejected");
    addSystemMessage(message.type === "name-updated"
      ? `Your display name is now ${session.clientName}.`
      : message.message || "That display name is already in use.");
  }

  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const message = chatInput.value.trim();
    if (!message) return;
    send({ type: "chat", message });
    chatInput.value = ""; chatInput.focus();
  });
  nameForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const nextName = displayNameInput.value.replace(/\s+/g, " ").trim().slice(0, 24);
    if (!nextName) {
      displayNameInput.value = session.clientName;
      return;
    }
    session.clientName = nextName;
    displayNameInput.value = session.clientName;
    try { localStorage.setItem("watchparty-display-name", session.clientName); } catch {}
    send({ type: "set-name", name: session.clientName });
    chatInput.focus();
  });
  displayNameInput.addEventListener("input", () => displayNameInput.removeAttribute("aria-invalid"));

  return { addSystemMessage, receive, acceptName, handleNameMessage };
}
