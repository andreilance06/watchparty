import { createPortal } from 'react-dom';
import { useLayoutEffect, useRef } from 'react';

export function Popover({ target, trigger, point, placement = 'top-end', className, label, menu, onClose, children }) {
  const ref = useRef(null), closeRef = useRef(onClose); closeRef.current = onClose;
  useLayoutEffect(() => {
    const box = ref.current;
    const position = () => {
      if (!trigger?.isConnected) { closeRef.current(); return; }
      const viewport = window.visualViewport;
      const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
      const left = (viewport?.offsetLeft || 0) + 8, top = (viewport?.offsetTop || 0) + 8;
      const anchor = trigger.getBoundingClientRect(), below = top + height - anchor.bottom - 24;
      box.style.maxWidth = `${width - 16}px`;
      box.style.maxHeight = `${placement.startsWith('bottom') && below >= 300 ? Math.min(below, height - 16) : height - 16}px`;
      box.style.setProperty('--message-menu-height', `${height - 16}px`);
      const bounds = box.getBoundingClientRect();
      const x = point?.x ?? (placement.endsWith('start') ? anchor.left : anchor.right - bounds.width);
      const y = point?.y ?? (placement.startsWith('bottom') ? anchor.bottom + 8 : anchor.top - bounds.height - 8);
      box.style.left = `${Math.max(left, Math.min(x, left + width - bounds.width - 16))}px`;
      box.style.top = `${Math.max(top, Math.min(y, top + height - bounds.height - 16))}px`;
    };
    position();
    const observer = new ResizeObserver(position); observer.observe(box);
    const outside = event => { if (!box.contains(event.target) && !trigger?.contains(event.target)) closeRef.current(); };
    const keyboard = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); trigger?.focus({ preventScroll: true }); }
      if (menu && ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const items = [...box.querySelectorAll('button:not(:disabled)')];
        const index = items.indexOf(document.activeElement);
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1) + items.length) % items.length]?.focus();
      }
      if (event.key === 'Tab' && menu) closeRef.current();
    };
    const layout = event => { if (!box.contains(event.target)) closeRef.current(); };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', keyboard, true);
    window.addEventListener('resize', position); window.addEventListener('scroll', layout, true);
    window.visualViewport?.addEventListener('resize', position); window.visualViewport?.addEventListener('scroll', position);
    box.querySelector('input, button:not(:disabled)')?.focus({ preventScroll: true });
    return () => { observer.disconnect(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keyboard, true); window.removeEventListener('resize', position); window.removeEventListener('scroll', layout, true); window.visualViewport?.removeEventListener('resize', position); window.visualViewport?.removeEventListener('scroll', position); };
  }, [trigger, point, menu, placement]);
  return createPortal(<div ref={ref} className={className} role={menu ? 'menu' : 'dialog'} aria-label={label}>{children}</div>, target);
}
