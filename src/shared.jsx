import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
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
export function Button({ variant = 'secondary', icon = false, pending = false, pendingLabel, disabled = false, type = 'button', className = '', children, ...props }) {
  return <button {...props} type={type} className={`ui-button ui-button--${variant}${icon ? ' ui-button--icon' : ''} ${className}`} disabled={disabled || pending} aria-busy={pending || undefined}>
    {pending && <span className="ui-spinner" aria-hidden="true" />}{pending && pendingLabel ? pendingLabel : children}
  </button>;
}
export function Input({ className = '', ...props }) {
  return <input {...props} className={`ui-input ${className}`} />;
}
export function Field({ id, label, optional = false, hint, error, className = '', 'aria-describedby': describedBy, ...props }) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const description = [describedBy, hint && `${inputId}-hint`, error && `${inputId}-error`].filter(Boolean).join(' ') || undefined;
  return <div className={`ui-field ${className}`}>
    <label className="ui-field-label" htmlFor={inputId}>{label}{optional && <span className="ui-field-optional"> (optional)</span>}</label>
    <Input {...props} id={inputId} aria-describedby={description} aria-invalid={error ? true : props['aria-invalid']} />
    {hint && <p id={`${inputId}-hint`} className="ui-field-hint">{hint}</p>}
    {error && <p id={`${inputId}-error`} className="ui-field-error" role="alert">{error}</p>}
  </div>;
}
export function Header({ children, brandHeading = true }) {
  const { theme, toggle } = useTheme();
  const label = `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`;
  return <header className="site-header flex items-center justify-between gap-4">
    <a className="brand" href="/"><img className="brand-mark" src="/assets/images/logo/logo_watchparty.png" alt="" /><div>{brandHeading ? <h1>WatchParty</h1> : <span className="brand-name">WatchParty</span>}<p>Watch together. Chat together.</p></div></a>
    <div className="header-actions flex items-center gap-3"><Button icon className="theme-toggle" aria-label={label} title={label} aria-pressed={theme === 'light'} onClick={toggle}>
      <svg className="theme-icon icon-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></svg>
      <svg className="theme-icon icon-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.4 15.2A8.5 8.5 0 0 1 8.8 3.6 8.5 8.5 0 1 0 20.4 15.2Z" /></svg>
    </Button>{children}</div>
  </header>;
}
export function Status({ children, className = '', tone = 'neutral', ...props }) {
  return <p {...props} className={`ui-status ui-status--${tone} ${className}`} role={tone === 'error' ? 'alert' : 'status'} aria-live={tone === 'error' ? 'assertive' : 'polite'}>{children}</p>;
}
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
export function Dialog({ open = true, onClose, title, children, className = '', wide = false, busy = false, returnFocusRef, initialFocusRef, onKeyDown, ...props }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    const returnTarget = returnFocusRef?.current || document.activeElement;
    if (open && !dialog.open) { dialog.showModal(); initialFocusRef?.current?.focus(); }
    else if (!open && dialog.open) dialog.close();
    return () => {
      if (dialog.open) dialog.close();
      // React may detach the dialog before passive cleanup; restore focus after native closing.
      queueMicrotask(() => {
        if (!dialog.open && returnTarget?.isConnected && !dialog.contains(returnTarget)) returnTarget.focus({ preventScroll: true });
      });
    };
  }, [open, returnFocusRef, initialFocusRef]);
  return <dialog {...props} ref={ref} className={`ui-dialog${wide ? ' ui-dialog--wide' : ''} ${className}`} aria-label={title} aria-busy={busy || undefined} onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); onKeyDown?.(event); }} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    {children}
  </dialog>;
}
export function DialogHeader({ title, eyebrow, onClose, busy = false }) {
  return <div className="ui-dialog-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2>{title}</h2></div>
    {onClose && <Button onClick={onClose} disabled={busy}>Close</Button>}
  </div>;
}
export async function request(path, options = {}) {
  const response = await fetch(path, options);
  let data;
  try { data = await response.json(); }
  catch (error) {
    if (error.name === 'AbortError') throw error;
    throw Object.assign(new Error(`The server returned an unexpected response (HTTP ${response.status}). Try again shortly.`), { status: response.status });
  }
  if (!data || typeof data !== 'object') throw Object.assign(new Error(`The server returned an unexpected response (HTTP ${response.status}). Try again shortly.`), { status: response.status });
  if (!response.ok) throw Object.assign(new Error(data.error || 'The request failed. Try again.'), { status: response.status, code: data.code });
  return data;
}
export const post = (path, body, signal) => request(path, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
export function navigate(path) { location.assign(path); }
