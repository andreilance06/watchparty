// Shared stroke icons for the hub and player; control labels carry their meaning.
const paths = {
  sparkles: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" /><path d="m20 2 .5 1.5L22 4l-1.5.5L20 6l-.5-1.5L18 4l1.5-.5ZM4 2v4M2 4h4" /></>,
  trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  smile: <><circle cx="12" cy="12" r="9" /><path d="M8 14a4 4 0 0 0 8 0M8 9h.01M16 9h.01" /></>,
  check: <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>,
  chat: <><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-3 3V11.5A8.5 8.5 0 0 1 9.5 3h3a8.5 8.5 0 0 1 8.5 8.5Z" /><path d="M7 9h8M7 13h5" /></>,
  people: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 4v2" /></>,
  vote: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="m7 8 1 1 2-2M13 8h4M7 13h3M13 13h4M7 17h10" /></>,
  invite: <><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2" /></>,
  settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></>,
  leave: <><path d="M10 3H4v18h6M10 12h11m-4-4 4 4-4 4" /></>,
  video: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m10 9 5 3-5 3Z" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  cards: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  list: <><path d="M9 5h12M9 12h12M9 19h12" /><path d="M3 5h1M3 12h1M3 19h1" /></>,
  filter: <><path d="M3 6h18M6 12h12M9 18h6" /></>,
  lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V6a4 4 0 0 1 8 0v4M12 15v2" /></>,
  edit: <><path d="m16 3 5 5M4 15 16 3a3.54 3.54 0 0 1 5 5L9 20l-7 2 2-7Z" /></>,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  screen: <><rect x="3" y="3" width="18" height="14" rx="2" /><path d="M8 21h8M12 17v4m-4-12 4-4 4 4M12 5v8" /></>,
};
export function Icon({ name, className = '' }) {
  return <svg className={`watch-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
