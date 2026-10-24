const REVEAL_MS = 4000;

export function createChatAttention({ elements }) {
  const { video, chatMessages, fullscreenChatToggle, fullscreenChatLabel, fullscreenChatUnread } = elements;
  const sound = createNotificationSound();
  let active = false, chatVisible = true, atLatest = true, unread = 0;
  let focused = document.hasFocus?.() ?? true;
  let controlsVisible = !video.classList.contains("movi-bar-collapsed");
  let revealing = false, revealTimer, revealOnFocus = false, onShown;

  const windowFocused = () => focused && !document.hidden;
  const chatShown = () => !active || chatVisible;

  function latestVisible() {
    const rect = chatMessages.getBoundingClientRect();
    const latest = chatMessages.children[chatMessages.children.length - 1];
    const bottom = latest?.getBoundingClientRect().bottom ?? rect.bottom;
    const viewport = window.visualViewport;
    const top = Math.max(rect.top, viewport?.offsetTop || 0);
    const viewportBottom = (viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight);
    return rect.width > 0 && rect.height > 0 && bottom > top &&
      bottom <= Math.min(rect.bottom, viewportBottom) + 2 &&
      rect.right > 0 && rect.left < window.innerWidth;
  }

  function render() {
    const label = chatVisible ? "Hide chat" : "Show chat";
    fullscreenChatLabel.textContent = label;
    fullscreenChatUnread.textContent = unread > 99 ? "99+" : String(unread);
    fullscreenChatUnread.hidden = unread === 0;
    fullscreenChatToggle.setAttribute("aria-label", `${label}${unread ? `, ${unread} unread ${unread === 1 ? "message" : "messages"}` : ""}`);
    fullscreenChatToggle.classList.toggle("is-idle", !controlsVisible && !revealing);
  }

  function reveal() {
    clearTimeout(revealTimer);
    revealing = true;
    revealTimer = setTimeout(() => { revealing = false; render(); }, REVEAL_MS);
    render();
  }

  function refresh() {
    if (unread && windowFocused() && chatShown() && atLatest && latestVisible()) {
      unread = 0;
      revealOnFocus = false;
    }
    render();
  }

  function regainAttention() {
    refresh();
    if (windowFocused() && unread && revealOnFocus) {
      revealOnFocus = false;
      reveal();
    }
  }

  window.addEventListener("blur", () => { focused = false; });
  window.addEventListener("focus", () => { focused = true; regainAttention(); });
  document.addEventListener("visibilitychange", () => {
    focused = document.hasFocus?.() ?? focused;
    regainAttention();
  });
  window.addEventListener("scroll", refresh, { capture: true, passive: true });
  window.addEventListener("resize", refresh);
  window.visualViewport?.addEventListener("resize", refresh);
  window.visualViewport?.addEventListener("scroll", refresh);
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(refresh).observe(chatMessages);
  if (typeof IntersectionObserver !== "undefined") {
    new IntersectionObserver(refresh, { threshold: [0, 1] }).observe(chatMessages);
  }
  video.addEventListener("controlschange", event => {
    controlsVisible = event.detail.visible;
    render();
  });
  render();

  return {
    setFullscreen({ active: nextActive, chatVisible: nextVisible }) {
      const wasShown = chatShown();
      const entering = nextActive && !active;
      active = nextActive;
      chatVisible = nextVisible;
      if (!wasShown && chatShown()) onShown?.();
      refresh();
      if (entering && unread) reveal();
      // Reparenting and fullscreen layout may settle after fullscreenchange.
      requestAnimationFrame(refresh);
    },
    setAtLatest(value) { atLatest = value; refresh(); },
    onChatShown(handler) { onShown = handler; },
    receiveMessage() {
      const away = !windowFocused();
      const hidden = !chatShown();
      if (hidden || away || !atLatest || !latestVisible()) {
        unread++;
        if (away) revealOnFocus = true;
        reveal();
      }
      if (hidden || away) sound.play();
      render();
    },
    refresh
  };
}

function createNotificationSound() {
  let audio, lastPlayed = -Infinity;
  function unlock() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!audio && AudioContext) audio = new AudioContext();
      if (audio?.state === "suspended") audio.resume().catch(() => {});
    } catch {}
  }
  document.addEventListener("pointerdown", unlock, { capture: true });
  document.addEventListener("keydown", unlock, { capture: true });
  return {
    play() {
      const now = performance.now();
      if (audio?.state !== "running" || now - lastPlayed < 1000) return;
      try {
        const tone = audio.createOscillator(), gain = audio.createGain();
        const start = audio.currentTime;
        tone.type = "sine";
        tone.frequency.setValueAtTime(880, start);
        tone.frequency.exponentialRampToValueAtTime(660, start + .16);
        gain.gain.setValueAtTime(.0001, start);
        gain.gain.exponentialRampToValueAtTime(.04, start + .015);
        gain.gain.exponentialRampToValueAtTime(.0001, start + .18);
        tone.connect(gain);
        gain.connect(audio.destination);
        tone.onended = () => { tone.disconnect(); gain.disconnect(); };
        tone.start(start);
        tone.stop(start + .2);
        lastPlayed = now;
      } catch {}
    }
  };
}
