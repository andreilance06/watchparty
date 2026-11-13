// Shared stroke icons for the hub and player; control labels carry their meaning.
const paths = {
  chat: <><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-3 3V11.5A8.5 8.5 0 0 1 9.5 3h3a8.5 8.5 0 0 1 8.5 8.5Z" /><path d="M7 9h8M7 13h5" /></>,
  people: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 4v2" /></>,
  vote: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="m7 8 1 1 2-2M13 8h4M7 13h3M13 13h4M7 17h10" /></>,
  invite: <><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2" /></>,
  settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></>,
  leave: <><path d="M10 3H4v18h6M10 12h11m-4-4 4 4-4 4" /></>,
  video: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m10 9 5 3-5 3Z" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V6a4 4 0 0 1 8 0v4M12 15v2" /></>,
  edit: <><path d="m16 3 5 5M4 15 16 3a3.54 3.54 0 0 1 5 5L9 20l-7 2 2-7Z" /></>,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
};
export function Icon({ name, className = '' }) {
  return <svg className={`watch-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
