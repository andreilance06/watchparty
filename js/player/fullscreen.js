import { createLifecycle } from "../utils/lifecycle.js";
export function createFullscreen({ elements, getHostPaused, afterResize, attention }) {
  const life = createLifecycle();
  const { video, videoShell, fullscreenButton, syncStatus, chatConversation, chatMessages,
    fullscreenChat, fullscreenChatToggle, floatingReactions, reactionFeed, emojiPicker, messageMenu, theaterRoot } = elements;
  // Whole-room theater keeps the sidebar mounted; standalone players move their conversation.
  const fullscreenRoot = theaterRoot || videoShell;
  let previousBodyOverflow = "";
  let mounted = false, chatVisible = true;
  let chatScrollTop = 0;
  const slots = [...(theaterRoot ? [] : [chatConversation]), floatingReactions, reactionFeed, emojiPicker, messageMenu].map(node => {
    const anchor = document.createElement("span");
    anchor.hidden = true;
    node.parentNode.insertBefore(anchor, node);
    return { node, anchor };
  });

  function updateChatVisibility() {
    if (!theaterRoot) {
      fullscreenChat.hidden = !mounted || !chatVisible;
      fullscreenChatToggle.hidden = !mounted;
      fullscreenChatToggle.setAttribute("aria-expanded", String(chatVisible));
      if (!mounted || chatVisible) chatMessages.scrollTop = chatScrollTop;
    }
  }

  function rememberChatScroll() {
    // display:none reports zero even though the hidden scroller retains a position.
    if (chatMessages.getBoundingClientRect().height) chatScrollTop = chatMessages.scrollTop;
  }

  function setChatVisible(visible) {
    document.dispatchEvent(new Event("watchparty-fullscreen-change"));
    rememberChatScroll();
    chatVisible = visible;
    updateChatVisibility();
    attention?.setFullscreen({ active: mounted, chatVisible });
    afterResize();
  }
  if (!theaterRoot) life.listen(fullscreenChatToggle, "click", () => setChatVisible(!chatVisible));

  function updateViewport() {
    const viewport = window.visualViewport;
    fullscreenRoot.style.setProperty("--chat-viewport-height", `${viewport?.height || window.innerHeight}px`);
    fullscreenRoot.style.setProperty("--chat-viewport-top", `${viewport?.offsetTop || 0}px`);
    fullscreenRoot.classList.toggle("chat-compact-viewport", (viewport?.height || window.innerHeight) < 360);
  }
  life.listen(window.visualViewport, "resize", updateViewport);
  life.listen(window.visualViewport, "scroll", updateViewport);
  life.listen(window, "resize", updateViewport);

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }
  
  function updateFullscreenUi() {
    const active = fullscreenElement() === fullscreenRoot || fullscreenRoot.classList.contains("pseudo-fullscreen");
    if (active !== mounted) {
      document.dispatchEvent(new Event("watchparty-fullscreen-change"));
      rememberChatScroll();
      const focused = document.activeElement;
      const restoreFocus = chatConversation.contains(focused);
      mounted = active;
      if (active) {
        if (!theaterRoot) fullscreenChat.appendChild(chatConversation);
        for (const node of [floatingReactions, reactionFeed, emojiPicker, messageMenu]) fullscreenRoot.appendChild(node);
      } else {
        for (const { node, anchor } of slots) anchor.parentNode.insertBefore(node, anchor);
      }
      updateChatVisibility();
      if (restoreFocus && (!active || chatVisible)) focused.focus({ preventScroll: true });
      attention?.setFullscreen({ active, chatVisible });
    }
    updateViewport();
    fullscreenButton.setAttribute("aria-label", active ? "Exit fullscreen" : "Enter fullscreen");
    fullscreenButton.title = active ? "Exit fullscreen" : "Fullscreen";
    if (typeof video.applyFullscreenUiState === "function") video.applyFullscreenUiState(active);
    afterResize();
  }
  
  async function toggleFullscreenSurface() {
    if (fullscreenElement()) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      return;
    }
    if (fullscreenRoot.classList.contains("pseudo-fullscreen")) {
      fullscreenRoot.classList.remove("pseudo-fullscreen");
      document.body.style.overflow = previousBodyOverflow;
      updateFullscreenUi();
      return;
    }
    if (fullscreenRoot.requestFullscreen) {
      await fullscreenRoot.requestFullscreen();
      return;
    }
    if (fullscreenRoot.webkitRequestFullscreen) {
      fullscreenRoot.webkitRequestFullscreen();
      return;
    }
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    fullscreenRoot.classList.add("pseudo-fullscreen");
    updateFullscreenUi();
  }
  
  life.listen(fullscreenButton, "click", async () => {
    try {
      // Firefox Mobile blocks remote play() calls with sound until the viewer
      // performs a gesture. This click supplies that gesture without exposing
      // play/pause or seeking controls to the viewer.
      video.muted = false;
      if (!Number.isFinite(video.volume) || video.volume < 0.05) video.volume = 1;
      const playAttempt = !getHostPaused()
        ? video.play().catch(() => {})
        : Promise.resolve();
      await toggleFullscreenSurface();
      await playAttempt;
    } catch { syncStatus.textContent = "Fullscreen is not available in this browser"; }
  });
  
  // Keep the responsive shell and player together, including the mobile
  // pseudo-fullscreen fallback. The caption surface now lives inside Movi.
  life.listen(video, "movi-fullscreen-request", (event) => {
    event.preventDefault();
    toggleFullscreenSurface().catch(() => {
      syncStatus.textContent = "Fullscreen is not available in this browser";
    });
  });

  life.listen(document, "fullscreenchange", updateFullscreenUi);
  life.listen(document, "webkitfullscreenchange", updateFullscreenUi);
  life.listen(document, "keydown", (event) => {
    if (event.key === "Escape" && !event.defaultPrevented && fullscreenRoot.classList.contains("pseudo-fullscreen")) {
      fullscreenRoot.classList.remove("pseudo-fullscreen");
      document.body.style.overflow = previousBodyOverflow;
      updateFullscreenUi();
    }
  });

  return { toggle: toggleFullscreenSurface, updateUi: updateFullscreenUi, setChatVisible, destroy() {
    life.dispose();
    for (const { node, anchor } of slots) { if (anchor.parentNode) anchor.parentNode.insertBefore(node, anchor); anchor.remove(); }
    if (fullscreenRoot.classList.contains("pseudo-fullscreen")) { fullscreenRoot.classList.remove("pseudo-fullscreen"); document.body.style.overflow = previousBodyOverflow; }
  } };
}
