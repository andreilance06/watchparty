import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const ThemeContext = createContext(null);
export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('watchparty-theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('watchparty-theme', theme); } catch { /* Private browsing may deny storage. */ }
  }, [theme]);
  return <ThemeContext.Provider value={{ theme, toggle: () => setTheme(value => value === 'light' ? 'dark' : 'light') }}>{children}</ThemeContext.Provider>;
}
export const useTheme = () => useContext(ThemeContext);
export function Header({ children }) {
  const { theme, toggle } = useTheme();
  const label = `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`;
  return <header className="site-header flex items-center justify-between gap-4">
    <a className="brand" href="/"><img className="brand-mark" src="/assets/images/logo/logo_watchparty.png" alt="" /><div><h1>WatchParty</h1><p>Watch together. Chat together.</p></div></a>
    <div className="header-actions flex items-center gap-3"><button className="theme-toggle" type="button" aria-label={label} title={label} aria-pressed={theme === 'light'} onClick={toggle}>
      <svg className="theme-icon icon-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></svg>
      <svg className="theme-icon icon-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.4 15.2A8.5 8.5 0 0 1 8.8 3.6 8.5 8.5 0 1 0 20.4 15.2Z" /></svg>
    </button>{children}</div>
  </header>;
}
export function Footer() { return <footer className="site-footer flex justify-between gap-4"><span>WatchParty</span><span>Watch together. Chat together.</span></footer>; }
export function Status({ children, className = '' }) { return <p className={className} role="status" aria-live="polite">{children}</p>; }
export function ParticipantPopover({ trigger, title, onClose, children }) {
  const ref = useRef(null), close = useRef(onClose); close.current = onClose;
  useLayoutEffect(() => {
    const node = ref.current;
    const position = () => {
      if (!trigger?.isConnected) { close.current(); return; }
      const anchor = trigger.getBoundingClientRect();
      const width = Math.min(288, innerWidth - 16); node.style.width = `${width}px`;
      node.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - width - 8))}px`;
      const height = Math.min(node.getBoundingClientRect().height, innerHeight - 16);
      const top = Math.max(8, Math.min(innerHeight - anchor.bottom - 16 >= height ? anchor.bottom + 6 : anchor.top - height - 6, innerHeight - height - 8));
      node.style.top = `${top}px`; node.style.maxHeight = `${innerHeight - top - 8}px`;
    };
    const outside = event => { if (!node.contains(event.target) && !trigger.contains(event.target)) close.current(); };
    const escape = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); } };
    const observer = new ResizeObserver(position); observer.observe(node); position();
    node.querySelector('button')?.focus({ preventScroll: true });
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    window.addEventListener('resize', position); window.addEventListener('scroll', position, true);
    return () => { observer.disconnect(); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [trigger]);
  return createPortal(<div ref={ref} className="participant-dropdown" role="dialog" aria-label={title}>{children}</div>, document.body);
}
export function Dialog({ open = true, onClose, title, children, className = 'hub-dialog', busy = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
    return () => { if (dialog.open) dialog.close(); };
  }, [open]);
  return <dialog ref={ref} className={className} aria-label={title} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    {children}
  </dialog>;
}
export async function request(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'The request failed. Try again.'), { status: response.status, code: data.code });
  return data;
}
export const post = (path, body, signal) => request(path, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
export function navigate(path) { location.assign(path); }
