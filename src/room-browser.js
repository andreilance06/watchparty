export const SORT_OPTIONS = [
  ['people-desc', 'Most people'], ['people-asc', 'Fewest people'],
  ['name-asc', 'Name A–Z'], ['name-desc', 'Name Z–A'],
  ['newest', 'Newest'], ['oldest', 'Oldest'],
];
export const BROWSER_PREFERENCE_KEY = 'watchparty-room-browser';
export const DEFAULT_BROWSER_PREFERENCES = { view: 'cards', sort: 'people-desc' };

export function readBrowserPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(BROWSER_PREFERENCE_KEY));
    return {
      view: ['cards', 'list'].includes(saved?.view) ? saved.view : 'cards',
      sort: SORT_OPTIONS.some(([key]) => key === saved?.sort) ? saved.sort : 'people-desc',
    };
  } catch { return { ...DEFAULT_BROWSER_PREFERENCES }; }
}

const compareNames = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
const timestamp = room => Number.isFinite(room.createdAt) && room.createdAt >= 0 ? room.createdAt : null;

export function selectRooms(rooms, { query = '', access = 'all', video = 'all', sort = 'people-desc' } = {}) {
  const search = query.trim().toLocaleLowerCase();
  return rooms.filter(room => {
    const matchesSearch = `${room.name} ${room.fileName || ''}`.toLocaleLowerCase().includes(search);
    const matchesAccess = access === 'all' || Boolean(room.passwordRequired) === (access === 'protected');
    const matchesVideo = video === 'all' || Boolean(room.fileName) === (video === 'selected');
    return matchesSearch && matchesAccess && matchesVideo;
  }).sort((a, b) => {
    let order;
    if (sort === 'name-asc' || sort === 'name-desc') order = compareNames(a, b) * (sort === 'name-desc' ? -1 : 1);
    else if (sort === 'newest' || sort === 'oldest') {
      const first = timestamp(a), second = timestamp(b);
      order = first === null ? (second === null ? 0 : 1) : second === null ? -1 : (first - second) * (sort === 'newest' ? -1 : 1);
    } else order = ((a.participantCount || 0) - (b.participantCount || 0)) * (sort === 'people-asc' ? 1 : -1);
    return order || compareNames(a, b) || a.id.localeCompare(b.id);
  });
}
