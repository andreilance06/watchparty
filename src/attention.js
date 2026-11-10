import { useEffect, useRef, useState } from 'react';

export function useAttention(attentionRef, socialVisible) {
  const [view, setView] = useState({ active: false, chatVisible: true, unread: 0, controlsVisible: true, revealing: false });
  const [notices, setNotices] = useState([]), [floating, setFloating] = useState([]);
  const current = useRef(view); current.current = view;
  const visible = useRef(socialVisible); visible.current = socialVisible;
  const atLatest = useRef(true), shown = useRef(null), timers = useRef(new Set()), audio = useRef(null), lastSound = useRef(-Infinity), serial = useRef(0);
  const revealTimer = useRef(null);
  const later = (callback, delay) => { const timer = setTimeout(() => { timers.current.delete(timer); callback(); }, delay); timers.current.add(timer); return timer; };
  const chatShown = () => current.current.active ? current.current.chatVisible : visible.current;
  const focused = () => !document.hidden && document.hasFocus();
  const latestVisible = () => {
    const node = document.getElementById('chatMessages');
    const box = node?.getBoundingClientRect();
    return box && box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight;
  };
  const refresh = () => { if (chatShown() && focused() && atLatest.current && latestVisible()) setView(value => value.unread ? { ...value, unread: 0 } : value); };
  function notice(item, duration = 4000) {
    const id = ++serial.current;
    setNotices(value => [...value, { ...item, id }].slice(-5));
    later(() => setNotices(value => value.filter(item => item.id !== id)), duration);
  }
  const apiRef = useRef({});
  Object.assign(apiRef.current, {
    setFullscreen(next) {
      const previousShown = chatShown(); current.current = { ...current.current, ...next }; setView(value => ({ ...value, ...next }));
      if (!next.active || next.chatVisible) setNotices([]);
      if (!previousShown && chatShown()) shown.current?.();
      requestAnimationFrame(refresh);
    },
    setAtLatest(value) { atLatest.current = value; refresh(); },
    onChatShown(handler) { shown.current = handler; },
    setSocialVisible(value) { const previous = chatShown(); visible.current = value; if (!previous && chatShown()) shown.current?.(); refresh(); },
    receiveMessage(message) {
      const away = !focused(), hidden = !chatShown();
      if (current.current.active && hidden) notice({ name: message.name, message: message.message }, 6000);
      if (away || hidden || !atLatest.current || !latestVisible()) {
        setView(value => ({ ...value, unread: value.unread + 1, revealing: true }));
        clearTimeout(revealTimer.current); revealTimer.current = later(() => setView(value => ({ ...value, revealing: false })), 4000);
      }
      if ((away || hidden) && audio.current?.state === 'running' && performance.now() - lastSound.current > 1000) {
        const context = audio.current, tone = context.createOscillator(), gain = context.createGain(), start = context.currentTime;
        tone.frequency.setValueAtTime(880, start); tone.frequency.exponentialRampToValueAtTime(660, start + .16);
        gain.gain.setValueAtTime(.0001, start); gain.gain.exponentialRampToValueAtTime(.04, start + .015); gain.gain.exponentialRampToValueAtTime(.0001, start + .18);
        tone.connect(gain); gain.connect(context.destination); tone.onended = () => { tone.disconnect(); gain.disconnect(); }; tone.start(); tone.stop(start + .2); lastSound.current = performance.now();
      }
    },
    receiveReaction(message) {
      if (!current.current.active || !current.current.chatVisible) notice({ emoji: message.emoji, name: message.name });
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const items = Array.from({ length: 6 }, (_, index) => ({ id: ++serial.current, emoji: message.emoji, left: `${10 + Math.random() * 80}%`, delay: `${index * 70}ms` }));
      setFloating(value => [...value, ...items].slice(-30));
      later(() => setFloating(value => value.filter(item => !items.some(old => old.id === item.id))), 2700);
    },
    controlsChange(value) { setView(view => ({ ...view, controlsVisible: value })); },
    refresh,
  });
  attentionRef.current = apiRef.current;
  useEffect(() => { apiRef.current.setSocialVisible(socialVisible); }, [socialVisible]);
  useEffect(() => {
    const unlock = () => {
      try { const Audio = window.AudioContext || window.webkitAudioContext; if (!audio.current && Audio) audio.current = new Audio(); audio.current?.resume().catch(() => {}); } catch { /* Browser audio permission. */ }
    };
    const refresh = () => apiRef.current.refresh();
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const motionChanged = () => { if (motion.matches) setFloating([]); };
    document.addEventListener('pointerdown', unlock, true); document.addEventListener('keydown', unlock, true);
    document.addEventListener('visibilitychange', refresh); window.addEventListener('focus', refresh); window.addEventListener('scroll', refresh, true); window.addEventListener('resize', refresh);
    motion.addEventListener('change', motionChanged);
    return () => {
      document.removeEventListener('pointerdown', unlock, true); document.removeEventListener('keydown', unlock, true); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('focus', refresh); window.removeEventListener('scroll', refresh, true); window.removeEventListener('resize', refresh); motion.removeEventListener('change', motionChanged);
      for (const timer of timers.current) clearTimeout(timer); timers.current.clear(); audio.current?.close().catch(() => {}); audio.current = null;
    };
  }, []);
  return { ...view, notices, floating };
}
