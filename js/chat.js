import { createEmojiPicker } from "./emoji-picker.js";
import { createMessageMenu } from "./message-menu.js";
import { createClientId } from "./utils/client-id.js";

const MAX_COMMENTS = 500;

export function createChat({ elements, state: session, send, attention }) {
  const {
    chatMessages, chatForm, chatInput, chatEmojiButton, emojiPicker, emojiSearch,
    emojiPickerGrid, emojiPickerEmpty, nameForm, displayNameInput,
    chatReplyPreview, chatReplyName, chatReplyText, chatReplyCancel, chatSendStatus,
    chatJumpLatest, messageMenu, emojiPickerTabs, emojiMessageTab, emojiGlobalTab, emojiPickerHint
  } = elements;
  const comments = new Map();
  let replyTarget = null, pending = null;
  let followLatest = true, pendingLatestScroll = false;
  const picker = createEmojiPicker({
    picker: emojiPicker, search: emojiSearch, grid: emojiPickerGrid, emptyMessage: emojiPickerEmpty,
    tabs: emojiPickerTabs, messageTab: emojiMessageTab, globalTab: emojiGlobalTab, hint: emojiPickerHint,
    onOpen: () => menu.close()
  });
  const menu = createMessageMenu({
    menu: messageMenu, beforeOpen: () => picker.close(),
    onReply: selectReply, onReact: toggleCommentReaction
  });
  displayNameInput.value = session.clientName;

  function showStatus(message = "") {
    chatSendStatus.textContent = message;
    chatSendStatus.hidden = !message;
  }

  function scrollToLatest() {
    pendingLatestScroll = !chatMessages.getBoundingClientRect().height;
    if (!pendingLatestScroll) chatMessages.scrollTop = chatMessages.scrollHeight;
    followLatest = true;
    chatJumpLatest.hidden = true;
    attention.setAtLatest(true);
  }

  function afterAppend() {
    if (followLatest) scrollToLatest();
    else chatJumpLatest.hidden = false;
  }

  chatMessages.addEventListener("scroll", () => {
    if (!chatMessages.getBoundingClientRect().height) return;
    followLatest = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 48;
    if (followLatest) chatJumpLatest.hidden = true;
    attention.setAtLatest(followLatest);
  });
  chatJumpLatest.addEventListener("click", scrollToLatest);
  attention.onChatShown(() => { if (followLatest && pendingLatestScroll) scrollToLatest(); });

  function selectReply(comment) {
    replyTarget = comment;
    chatReplyPreview.hidden = !comment;
    chatReplyName.textContent = comment ? `Reply to ${comment.name}` : "";
    chatReplyText.textContent = comment?.message || "";
    showStatus();
    chatInput.focus({ preventScroll: true });
  }
  chatReplyCancel.addEventListener("click", () => selectReply(null));

  function addSystemMessage(message) {
    const element = document.createElement("div");
    element.className = "system-message";
    element.textContent = message;
    chatMessages.appendChild(element);
    afterAppend();
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
    for (const [emoji, count] of counts) {
      if (!comment.buttons.has(emoji)) addCommentReactionButton(comment, emoji, emoji, count);
    }
    for (const [emoji, { button, countElement, label }] of comment.buttons) {
      const count = counts.get(emoji) || 0;
      if (!count) {
        button.setAttribute("aria-pressed", "false");
        button.remove();
        comment.buttons.delete(emoji);
        continue;
      }
      const reactors = names.get(emoji);
      const reactorNames = reactors.join(", ");
      button.setAttribute("aria-label", `${emoji}, ${count} ${count === 1 ? "reaction" : "reactions"} from ${reactorNames}${comment.myReaction === emoji ? ", your reaction" : ""}`);
      button.title = `${label}: ${reactorNames}`;
      button.setAttribute("aria-pressed", String(comment.myReaction === emoji));
      countElement.textContent = String(count);
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
    comment.reactionBar.insertBefore(button, comment.feedback);
  }

  function toggleCommentReaction(comment, emoji) {
    const nextEmoji = comment.myReaction === emoji ? null : emoji;
    if (send({
      type: "comment-reaction",
      commentId: comment.commentId,
      emoji: nextEmoji
    }) === false) { showStatus("Reconnect to react to a message."); return; }
  }

  function reactionFeedback(comment, emoji) {
    comment.feedback.textContent = emoji || "";
    comment.feedback.classList.remove("pop");
    void comment.feedback.offsetWidth;
    comment.feedback.classList.add("pop");
    clearTimeout(comment.feedbackTimer);
    comment.feedbackTimer = setTimeout(() => comment.feedback.classList.remove("pop"), 650);
  }

  function addChatMessage({ commentId, name, message, time, self, replyTo }) {
    commentId ||= createClientId();
    if (comments.has(commentId)) return;
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
      commentId, name, message, article, buttons: new Map(), feedback: null, reactions: new Map(),
      reactionBar, myReaction: null
    };
    const feedback = document.createElement("span");
    feedback.className = "comment-reaction-feedback";
    feedback.setAttribute("aria-hidden", "true");
    reactionBar.appendChild(feedback);
    comment.feedback = feedback;
    meta.append(who, when);
    article.append(meta, text, reactionBar);
    menu.bind(comment);
    if (replyTo) {
      const quote = document.createElement("button");
      quote.type = "button";
      quote.className = "chat-reply-quote";
      const author = document.createElement("strong"); author.textContent = replyTo.name;
      const excerpt = document.createElement("span"); excerpt.textContent = replyTo.message;
      quote.append(author, excerpt);
      quote.setAttribute("aria-label", `View original message from ${replyTo.name}: ${replyTo.message}`);
      quote.addEventListener("click", () => {
        const original = comments.get(replyTo.commentId);
        if (!original) { showStatus("Original message unavailable"); return; }
        const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
        original.article.scrollIntoView({ block: "center", behavior: reduced ? "instant" : "smooth" });
        followLatest = false;
        attention.setAtLatest(false);
        chatJumpLatest.hidden = false;
        original.article.classList.add("reply-highlight");
        clearTimeout(original.highlightTimer);
        original.highlightTimer = setTimeout(() => original.article.classList.remove("reply-highlight"), 1600);
      });
      article.insertBefore(quote, text);
    }
    comments.set(commentId, comment);
    chatMessages.appendChild(article);
    while (comments.size > MAX_COMMENTS) {
      const [oldId, old] = comments.entries().next().value;
      picker.closeFor(old.article);
      menu.closeFor(old);
      clearTimeout(old.feedbackTimer);
      clearTimeout(old.highlightTimer);
      old.article.remove();
      comments.delete(oldId);
    }
    afterAppend();
    if (!self) attention.receiveMessage();
  }

  function acceptName(name, invalid = false) {
    session.clientName = name;
    displayNameInput.value = name;
    if (invalid) displayNameInput.setAttribute("aria-invalid", "true");
    else displayNameInput.removeAttribute("aria-invalid");
    try { localStorage.setItem("watchparty-display-name", name); } catch {}
  }

  function receive(message) {
    if (pending && message.clientId === session.clientId && message.requestId === pending.requestId) {
      if (chatInput.value === pending.draft) chatInput.value = "";
      if (replyTarget === pending.replyTarget) selectReply(null);
      pending = null;
      chatForm.removeAttribute("aria-busy");
      showStatus();
    }
    addChatMessage({ ...message, self: message.clientId === session.clientId });
  }

  function rejectSend(message) {
    if (!pending || message.requestId !== pending.requestId) return;
    pending = null;
    chatForm.removeAttribute("aria-busy");
    showStatus(message.message);
  }

  function setConnected(connected) {
    if (!connected && pending) {
      pending = null;
      chatForm.removeAttribute("aria-busy");
      showStatus("Connection lost. Your draft is saved here; reconnect before sending again.");
    }
  }

  function receiveCommentReaction(message) {
    const comment = comments.get(message.commentId);
    if (!comment || !Array.isArray(message.reactions)) return;
    const previous = comment.myReaction;
    comment.reactions.clear();
    for (const reaction of message.reactions) {
      if (reaction?.clientId && reaction.emoji) {
        comment.reactions.set(reaction.clientId, { emoji: reaction.emoji, name: reaction.name || "Guest" });
      }
    }
    comment.myReaction = "myReaction" in message ? message.myReaction
      : comment.reactions.get(session.clientId)?.emoji || null;
    updateCommentReactions(comment);
    menu.refresh(comment);
    if (previous !== comment.myReaction) reactionFeedback(comment, comment.myReaction || previous);
  }

  chatEmojiButton.addEventListener("click", () => {
    let start = chatInput.selectionStart ?? chatInput.value.length;
    let end = chatInput.selectionEnd ?? start;
    picker.open(chatEmojiButton, (emoji) => {
      const next = chatInput.value.slice(0, start) + emoji + chatInput.value.slice(end);
      if (next.length > (chatInput.maxLength || 300)) return;
      chatInput.value = next;
      start += emoji.length;
      end = start;
      if (typeof chatInput.setSelectionRange === "function") {
        chatInput.setSelectionRange(start, end);
      }
    }, "Emojis and global reactions", emoji => {
      if (send({ type: "reaction", emoji }) === false) showStatus("Reconnect to send a reaction.");
    });
  });

  function handleNameMessage(message) {
    acceptName(message.name, message.type === "name-rejected");
    addSystemMessage(message.type === "name-updated"
      ? `Your display name is now ${session.clientName}.`
      : message.message || "That display name is already in use.");
  }

  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const message = chatInput.value.trim();
    if (!message || pending) return;
    const requestId = createClientId();
    pending = { requestId, draft: chatInput.value, replyTarget };
    if (send({ type: "chat", message, requestId, ...(replyTarget ? { replyToId: replyTarget.commentId } : {}) }) === false) {
      pending = null;
      showStatus("Reconnect to send your message. Your draft is saved here.");
      return;
    }
    chatForm.setAttribute("aria-busy", "true");
    showStatus();
    chatInput.focus();
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

  return { addSystemMessage, receive, receiveCommentReaction, acceptName, handleNameMessage, rejectSend, setConnected };
}
