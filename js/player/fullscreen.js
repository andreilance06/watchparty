export function createFullscreen({ elements, getHostPaused, afterResize, attention }) {
  const { video, videoShell, fullscreenButton, syncStatus, chatConversation, chatMessages,
    fullscreenChat, fullscreenChatToggle, floatingReactions, reactionFeed, emojiPicker, messageMenu } = elements;
  let previousBodyOverflow = "";
  let mounted = false, chatVisible = true;
  let chatScrollTop = 0;
  const slots = [chatConversation, floatingReactions, reactionFeed, emojiPicker, messageMenu].map(node => {
    const anchor = document.createElement("span");
    anchor.hidden = true;
    node.parentNode.insertBefore(anchor, node);
    return { node, anchor };
  });

  function updateChatVisibility() {
    fullscreenChat.hidden = !mounted || !chatVisible;
    fullscreenChatToggle.hidden = !mounted;
    fullscreenChatToggle.setAttribute("aria-expanded", String(chatVisible));
    if (!mounted || chatVisible) chatMessages.scrollTop = chatScrollTop;
  }

  function rememberChatScroll() {
    // display:none reports zero even though the hidden scroller retains a position.
    if (chatMessages.getBoundingClientRect().height) chatScrollTop = chatMessages.scrollTop;
  }

  fullscreenChatToggle.addEventListener("click", () => {
    document.dispatchEvent(new Event("watchparty-fullscreen-change"));
    rememberChatScroll();
    chatVisible = !chatVisible;
    updateChatVisibility();
    attention?.setFullscreen({ active: mounted, chatVisible });
  });

  function updateViewport() {
    const viewport = window.visualViewport;
    videoShell.style.setProperty("--chat-viewport-height", `${viewport?.height || window.innerHeight}px`);
    videoShell.style.setProperty("--chat-viewport-top", `${viewport?.offsetTop || 0}px`);
    videoShell.classList.toggle("chat-compact-viewport", (viewport?.height || window.innerHeight) < 360);
  }
  window.visualViewport?.addEventListener("resize", updateViewport);
  window.visualViewport?.addEventListener("scroll", updateViewport);
  window.addEventListener("resize", updateViewport);

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }
  
  function updateFullscreenUi() {
    const active = fullscreenElement() === videoShell || videoShell.classList.contains("pseudo-fullscreen");
    if (active !== mounted) {
      document.dispatchEvent(new Event("watchparty-fullscreen-change"));
      rememberChatScroll();
      const focused = document.activeElement;
      const restoreFocus = chatConversation.contains(focused);
      mounted = active;
      if (active) {
        fullscreenChat.appendChild(chatConversation);
        for (const node of [floatingReactions, reactionFeed, emojiPicker, messageMenu]) videoShell.appendChild(node);
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
    if (videoShell.classList.contains("pseudo-fullscreen")) {
      videoShell.classList.remove("pseudo-fullscreen");
      document.body.style.overflow = previousBodyOverflow;
      updateFullscreenUi();
      return;
    }
    if (videoShell.requestFullscreen) {
      await videoShell.requestFullscreen();
      return;
    }
    if (videoShell.webkitRequestFullscreen) {
      videoShell.webkitRequestFullscreen();
      return;
    }
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    videoShell.classList.add("pseudo-fullscreen");
    updateFullscreenUi();
  }
  
  fullscreenButton.addEventListener("click", async () => {
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
  video.addEventListener("movi-fullscreen-request", (event) => {
    event.preventDefault();
    toggleFullscreenSurface().catch(() => {
      syncStatus.textContent = "Fullscreen is not available in this browser";
    });
  });

  document.addEventListener("fullscreenchange", updateFullscreenUi);
  document.addEventListener("webkitfullscreenchange", updateFullscreenUi);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.defaultPrevented && videoShell.classList.contains("pseudo-fullscreen")) {
      videoShell.classList.remove("pseudo-fullscreen");
      document.body.style.overflow = previousBodyOverflow;
      updateFullscreenUi();
    }
  });

  return { toggle: toggleFullscreenSurface, updateUi: updateFullscreenUi };
}
