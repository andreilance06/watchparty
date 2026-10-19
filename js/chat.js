import { createEmojiPicker } from "./emoji-picker.js";

export function createChat({ elements, state: session, send }) {
  const {
    chatMessages, chatForm, chatInput, chatEmojiButton, emojiPicker, emojiSearch,
    emojiPickerGrid, emojiPickerEmpty, nameForm, displayNameInput
  } = elements;
  const comments = new Map();
  const picker = createEmojiPicker({
    picker: emojiPicker, search: emojiSearch, grid: emojiPickerGrid, emptyMessage: emojiPickerEmpty
  });
  displayNameInput.value = session.clientName;

  function addSystemMessage(message) {
    const element = document.createElement("div");
    element.className = "system-message";
    element.textContent = message;
    chatMessages.appendChild(element);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
  
  function updateCommentReactions(comment) {
    const counts = new Map();
    const names = new Map();
    for (const reaction of comment.reactions.values()) {
      counts.set(reaction.emoji, (counts.get(reaction.emoji) || 0) + 1);
      const emojiNames = names.get(reaction.emoji) || [];
      emojiNames.push(reaction.name);
      names.set(reaction.emoji, emojiNames);
    }
    for (const [emoji, { button, countElement, label }] of comment.buttons) {
      const count = counts.get(emoji) || 0;
      if (!count) {
        button.remove();
        comment.buttons.delete(emoji);
        continue;
      }
      const reactors = names.get(emoji);
      const reactorNames = reactors.join(", ");
      button.setAttribute("aria-label", `${emoji}, ${count} ${count === 1 ? "reaction" : "reactions"} from ${reactorNames}${comment.reactions.get(session.clientId)?.emoji === emoji ? ", your reaction" : ""}`);
      button.title = `${label}: ${reactorNames}`;
      button.setAttribute("aria-pressed", String(comment.reactions.get(session.clientId)?.emoji === emoji));
      countElement.textContent = String(count);
    }
    for (const [emoji, count] of counts) {
      if (!comment.buttons.has(emoji)) addCommentReactionButton(comment, emoji, emoji, count);
    }
  }

  function addCommentReactionButton(comment, emoji, label = emoji, initialCount = 0) {
    if (comment.buttons.has(emoji)) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "comment-reaction";
    button.setAttribute("aria-label", `React with ${label}, ${initialCount} ${initialCount === 1 ? "reaction" : "reactions"}`);
    button.setAttribute("aria-pressed", "false");
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = emoji;
    const countElement = document.createElement("span");
    countElement.textContent = String(initialCount);
    button.append(icon, countElement);
    button.addEventListener("click", () => toggleCommentReaction(comment, emoji));
    comment.buttons.set(emoji, { button, countElement, label });
    comment.reactionBar.insertBefore(button, comment.pickerButton);
  }

  function toggleCommentReaction(comment, emoji) {
    const selected = comment.reactions.get(session.clientId);
    const nextEmoji = selected === emoji ? null : emoji;
    send({
      type: "comment-reaction",
      commentId: comment.commentId,
      emoji: nextEmoji
    });
    applyCommentReaction(comment, session.clientId, nextEmoji, session.clientName);
  }

  function applyCommentReaction(comment, clientId, emoji, name = "Guest") {
    const previous = comment.reactions.get(clientId);
    if (previous?.emoji === emoji && (!emoji || previous.name === name)) return;
    if (emoji) comment.reactions.set(clientId, { emoji, name });
    else comment.reactions.delete(clientId);
    updateCommentReactions(comment);
    comment.feedback.textContent = emoji || previous?.emoji || "";
    comment.feedback.classList.remove("pop");
    void comment.feedback.offsetWidth;
    comment.feedback.classList.add("pop");
    setTimeout(() => comment.feedback.classList.remove("pop"), 650);
  }

  function addChatMessage({ commentId, name, message, time, self }) {
    const article = document.createElement("article");
    article.className = `chat-message${self ? " self" : ""}`;
    article.dataset.commentId = commentId;
    const meta = document.createElement("div"); meta.className = "meta";
    const who = document.createElement("span"); who.className = "name"; who.textContent = name;
    const when = document.createElement("time"); when.textContent = time;
    const text = document.createElement("p"); text.textContent = message;
    const reactionBar = document.createElement("div");
    reactionBar.className = "comment-reactions";
    const comment = {
      commentId, buttons: new Map(), feedback: null, reactions: new Map(),
      reactionBar, pickerButton: null
    };
    const pickerButton = document.createElement("button");
    pickerButton.type = "button";
    pickerButton.className = "comment-reaction comment-reaction-more";
    pickerButton.textContent = "＋";
    pickerButton.setAttribute("aria-label", "Choose another reaction");
    pickerButton.setAttribute("aria-expanded", "false");
    pickerButton.addEventListener("click", () => picker.open(
      pickerButton,
      (emoji) => {
        toggleCommentReaction(comment, emoji);
      }
    ));
    comment.pickerButton = pickerButton;
    reactionBar.appendChild(pickerButton);
    const feedback = document.createElement("span");
    feedback.className = "comment-reaction-feedback";
    feedback.setAttribute("aria-hidden", "true");
    reactionBar.appendChild(feedback);
    comment.feedback = feedback;
    meta.append(who, when);
    article.append(meta, text, reactionBar);
    comments.set(commentId, comment);
    chatMessages.appendChild(article);
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

  function receiveCommentReaction(message) {
    const comment = comments.get(message.commentId);
    if (!comment) return;
    if (Array.isArray(message.reactions)) {
      comment.reactions.clear();
      for (const reaction of message.reactions) {
        if (reaction?.clientId && reaction.emoji) {
          addCommentReactionButton(comment, reaction.emoji);
          comment.reactions.set(reaction.clientId, {
            emoji: reaction.emoji, name: reaction.name || "Guest"
          });
        }
      }
      updateCommentReactions(comment);
      return;
    }
    if (message.emoji) addCommentReactionButton(comment, message.emoji);
    applyCommentReaction(comment, message.clientId, message.emoji, message.name || "Guest");
  }

  chatEmojiButton.addEventListener("click", () => picker.open(chatEmojiButton, (emoji) => {
    const start = chatInput.selectionStart ?? chatInput.value.length;
    const end = chatInput.selectionEnd ?? start;
    const next = chatInput.value.slice(0, start) + emoji + chatInput.value.slice(end);
    if (next.length > (chatInput.maxLength || 300)) {
      chatInput.focus();
      return;
    }
    chatInput.value = next;
    chatInput.focus();
    if (typeof chatInput.setSelectionRange === "function") {
      const position = Math.min(start + emoji.length, chatInput.value.length);
      chatInput.setSelectionRange(position, position);
    }
  }));

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

  return { addSystemMessage, receive, receiveCommentReaction, acceptName, handleNameMessage };
}
