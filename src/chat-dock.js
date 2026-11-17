import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export const CHAT_DOCK_KEY = 'watchparty-chat-dock';
const DEFAULT_WIDTH = 380;
const clamp = (value, min, max) => Math.round(Math.min(max, Math.max(min, value)));
function savedDock() {
  try {
    const value = JSON.parse(localStorage.getItem(CHAT_DOCK_KEY));
    return { open: typeof value?.open === 'boolean' ? value.open : true,
      width: Number.isFinite(value?.width) ? clamp(value.width, 280, 640) : DEFAULT_WIDTH };
  } catch { return { open: true, width: DEFAULT_WIDTH }; }
}

export function useChatDock(theater) {
  const [saved, setSaved] = useState(savedDock);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [resizing, setResizing] = useState(false);
  const drag = useRef(null), suppressClick = useRef(false);
  const sideBySide = viewport.width >= 768 || (viewport.width >= 600 && viewport.height <= 500);
  const max = Math.floor(Math.max(280, Math.min(640, viewport.width - 320, viewport.width * .6)));
  const min = Math.min(320, max);
  const width = clamp(saved.width, min, max);
  useLayoutEffect(() => {
    const measure = () => setViewport({ width: theater.current?.clientWidth || window.innerWidth, height: window.innerHeight });
    measure();
    const observer = new ResizeObserver(measure);
    if (theater.current) observer.observe(theater.current);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [theater]);
  useEffect(() => {
    // Commit once a drag ends, not on every pointer movement. Viewport clamping is temporary.
    if (!resizing) try { localStorage.setItem(CHAT_DOCK_KEY, JSON.stringify(saved)); } catch { /* Optional preference. */ }
  }, [saved, resizing]);
  useEffect(() => {
    const active = drag.current;
    if (sideBySide || !active) return;
    drag.current = null; setResizing(false);
    suppressClick.current = active.moved;
    setSaved(previous => ({ ...previous, width: active.savedWidth, open: active.wasOpen }));
    if (active.target.hasPointerCapture?.(active.id)) active.target.releasePointerCapture(active.id);
  }, [sideBySide]);
  useEffect(() => () => {
    const active = drag.current; drag.current = null;
    if (active?.target.hasPointerCapture?.(active.id)) active.target.releasePointerCapture(active.id);
  }, []);
  const resize = value => setSaved(previous => ({ ...previous, width: clamp(value, min, max) }));
  function finish(event, cancel = false) {
    const active = drag.current;
    if (!active || (event.pointerId !== undefined && event.pointerId !== active.id)) return;
    drag.current = null;
    suppressClick.current = active.moved || cancel;
    if (cancel) setSaved(previous => ({ ...previous, width: active.savedWidth, open: active.wasOpen }));
    setResizing(false);
    if (event.currentTarget.hasPointerCapture?.(active.id)) event.currentTarget.releasePointerCapture(active.id);
  }
  return {
    open: saved.open, setOpen: value => setSaved(previous => ({ ...previous, open: typeof value === 'function' ? value(previous.open) : value })),
    width, min: Math.round(min), max: Math.floor(max), resizing, sideBySide,
    toggleProps: {
      onClick(event) {
        if (event.currentTarget.getAttribute('role') === 'separator') { suppressClick.current = false; return; }
        if (suppressClick.current && event.detail !== 0) { suppressClick.current = false; return; }
        suppressClick.current = false;
        document.dispatchEvent(new Event('watchparty-fullscreen-change'));
        setSaved(previous => ({ ...previous, open: !previous.open }));
      },
      onPointerDown(event) {
        if (event.button !== 0 || drag.current) return;
        suppressClick.current = false;
        if (!sideBySide) return;
        event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
        drag.current = { id: event.pointerId, x: event.clientX, width: saved.open ? width : 0, savedWidth: saved.width, wasOpen: saved.open, moved: false, target: event.currentTarget };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      },
      onPointerMove(event) {
        const active = drag.current;
        if (!active || active.id !== event.pointerId) return;
        const distance = active.x - event.clientX;
        if (!active.moved && (Math.abs(distance) < 6 || (!active.wasOpen && distance < 0))) return;
        if (!active.moved) { active.moved = true; setResizing(true); document.dispatchEvent(new Event('watchparty-fullscreen-change')); }
        setSaved(previous => ({ ...previous, open: true, width: clamp(active.width + distance, min, max) }));
      },
      onPointerUp: event => finish(event), onLostPointerCapture: event => finish(event), onPointerCancel: event => finish(event, true),
      onKeyDown(event) {
        if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); finish(event, true); return; }
        if (!sideBySide) return;
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const step = event.shiftKey ? 64 : 16;
        if (!saved.open) { if (event.key !== 'ArrowRight') setSaved(previous => ({ ...previous, open: true })); return; }
        resize(event.key === 'Home' ? min : event.key === 'End' ? max : width + (event.key === 'ArrowLeft' ? step : -step));
      },
    },
  };
}
