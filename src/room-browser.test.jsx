import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { Hub } from './Hub.jsx';
import { ThemeProvider } from './shared.jsx';
import { BROWSER_PREFERENCE_KEY, DEFAULT_BROWSER_PREFERENCES, readBrowserPreferences, selectRooms } from './room-browser.js';

vi.mock('./shared.jsx', async original => ({ ...await original(), navigate: vi.fn() }));
afterEach(() => vi.useRealTimers());
const rooms = [
  { id: 'z', name: 'Zebra', participantCount: 4, passwordRequired: true, fileName: 'Orbit.mp4', createdAt: 100, watchPath: '/watch?roomId=z' },
  { id: 'b', name: 'Beta', participantCount: 2, passwordRequired: false, fileName: null, createdAt: 300, watchPath: '/watch?roomId=b' },
  { id: 'a', name: 'Alpha', participantCount: 2, passwordRequired: false, fileName: 'Orbit.mp4', createdAt: 200, watchPath: '/watch?roomId=a' },
];
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const ids = result => result.map(room => room.id);
it('redeems protected invite access from the fragment and clears it from the address bar', async () => {
  history.replaceState(null, '', '/?room=z#invite=private-access-key');
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (url === '/api/rooms') return response({ rooms });
    if (url === '/api/viewer-identity') return response({});
    return response({ room: { watchPath: '/watch?roomId=z' } });
  });
  mount();
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/rooms/join', expect.objectContaining({ body: expect.any(String) })));
  const call = fetch.mock.calls.find(([url]) => url === '/api/rooms/join');
  expect(JSON.parse(call[1].body)).toMatchObject({ roomId: 'z', inviteKey: 'private-access-key' });
  expect(location.hash).toBe('');
  expect(screen.queryByLabelText('Room password')).not.toBeInTheDocument();
});
const renderedNames = () => screen.queryAllByRole('heading', { level: 3 }).map(node => node.textContent);
function mount() { return render(<ThemeProvider><Hub /></ThemeProvider>); }

it.each([
  ['people-desc', ['z', 'a', 'b']], ['people-asc', ['a', 'b', 'z']],
  ['name-asc', ['a', 'b', 'z']], ['name-desc', ['z', 'b', 'a']],
  ['newest', ['b', 'a', 'z']], ['oldest', ['z', 'a', 'b']],
])('sorts rooms by %s without mutating the directory', (sort, expected) => {
  const frozen = Object.freeze(rooms.map(room => Object.freeze({ ...room })));
  expect(ids(selectRooms(frozen, { sort }))).toEqual(expected);
  expect(ids(frozen)).toEqual(['z', 'b', 'a']);
});
it('combines search, access, and video filters and uses names and IDs to resolve ties', () => {
  expect(ids(selectRooms(rooms, { query: ' ORBIT ', access: 'open', video: 'selected' }))).toEqual(['a']);
  expect(ids(selectRooms(rooms, { access: 'protected', video: 'waiting' }))).toEqual([]);
  expect(ids(selectRooms(rooms, { video: 'waiting' }))).toEqual(['b']);
  const tied = [{ ...rooms[0], id: 'b', name: 'alpha' }, { ...rooms[0], id: 'a', name: 'Alpha' }];
  for (const sort of ['people-desc', 'people-asc', 'name-asc', 'name-desc', 'newest', 'oldest']) expect(ids(selectRooms(tied, { sort }))).toEqual(['a', 'b']);
});
it.each(['newest', 'oldest'])('places missing or invalid timestamps last for %s', sort => {
  const data = [{ ...rooms[0], id: 'unknown', createdAt: undefined }, ...rooms, { ...rooms[0], id: 'invalid', createdAt: '400' }];
  expect(ids(selectRooms(data, { sort })).slice(-2)).toEqual(['invalid', 'unknown']);
});
it('validates saved preferences and tolerates unavailable storage', () => {
  for (const value of ['broken', 'null', '{"view":"table","sort":"invalid"}']) {
    localStorage.setItem(BROWSER_PREFERENCE_KEY, value);
    expect(readBrowserPreferences()).toEqual(DEFAULT_BROWSER_PREFERENCES);
  }
  localStorage.setItem(BROWSER_PREFERENCE_KEY, '{"view":"list","sort":"newest","access":"protected"}');
  expect(readBrowserPreferences()).toEqual({ view: 'list', sort: 'newest' });
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Denied'); });
  expect(readBrowserPreferences()).toEqual(DEFAULT_BROWSER_PREFERENCES);
});
it('combines controls, resets search/filters, and remembers only layout and sort', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ rooms }));
  const user = userEvent.setup(), view = mount();
  await screen.findByText('Zebra');
  expect(renderedNames()).toEqual(['Zebra', 'Alpha', 'Beta']);
  await user.click(screen.getByRole('button', { name: 'List', exact: true }));
  await user.selectOptions(screen.getByLabelText('Sort by'), 'newest');
  expect(renderedNames()).toEqual(['Beta', 'Alpha', 'Zebra']);
  await user.click(screen.getByRole('button', { name: 'Filters', exact: true }));
  await user.selectOptions(screen.getByLabelText('Access'), 'open');
  await user.selectOptions(screen.getByLabelText('Video'), 'selected');
  await user.type(screen.getByRole('searchbox'), 'orbit');
  expect(renderedNames()).toEqual(['Alpha']); expect(screen.getByText('1 of 3 rooms')).toBeVisible();
  expect(screen.getByRole('button', { name: /Filters.*2.*active/ })).toHaveAttribute('aria-expanded', 'true');
  await user.click(screen.getByRole('button', { name: /Clear all/ }));
  expect(renderedNames()).toEqual(['Beta', 'Alpha', 'Zebra']);
  expect(screen.getByRole('button', { name: 'List', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await user.selectOptions(screen.getByLabelText('Access'), 'protected');
  await user.type(screen.getByRole('searchbox'), 'missing');
  expect(screen.getByText('No rooms match your search or filters.')).toBeVisible();
  view.unmount(); mount(); await screen.findByText('Zebra');
  expect(renderedNames()).toEqual(['Beta', 'Alpha', 'Zebra']); expect(screen.getByRole('searchbox')).toHaveValue('');
  expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCE_KEY))).toEqual({ view: 'list', sort: 'newest' });
});
it('preserves browsing choices through a directory refresh', async () => {
  vi.useFakeTimers();
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ rooms }));
  mount(); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'List', exact: true }));
  fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'name-desc' } });
  fireEvent.click(screen.getByRole('button', { name: 'Filters', exact: true }));
  fireEvent.change(screen.getByLabelText('Access'), { target: { value: 'open' } });
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'a' } });
  fetch.mockResolvedValue(response({ rooms: rooms.map(room => ({ ...room, participantCount: 8 })) }));
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(fetch).toHaveBeenCalledTimes(2); expect(renderedNames()).toEqual(['Beta', 'Alpha']);
  expect(screen.getByLabelText('Access')).toHaveValue('open'); expect(screen.getByLabelText('Sort by')).toHaveValue('name-desc');
  expect(screen.getByRole('searchbox')).toHaveValue('a');
  expect(screen.getByRole('button', { name: 'List', exact: true })).toHaveAttribute('aria-pressed', 'true');
});
it.each([['cards', ''], ['list', ''], ['cards', ' from thumbnail'], ['list', ' from thumbnail']])('preserves joining feedback and protected-room entry in %s view%s', async (view, suffix) => {
  localStorage.setItem(BROWSER_PREFERENCE_KEY, JSON.stringify({ view, sort: 'people-desc' }));
  let resolveJoin;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => url === '/api/rooms' ? response({ rooms }) : url.endsWith('/api/session') ? response({ error: 'Join first.' }, 401) : url === '/api/rooms/join' ? new Promise(resolve => { resolveJoin = resolve; }) : response({}));
  const user = userEvent.setup(); mount();
  await user.click(await screen.findByRole('button', { name: `Join Alpha${suffix}` }));
  expect(screen.getByRole('button', { name: 'Joining Alpha' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Join Zebra' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Join Alpha from thumbnail' })).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('button', { name: 'Join Zebra from thumbnail' })).toBeDisabled();
  await act(async () => { resolveJoin(response({ room: rooms[2] })); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Join Zebra' })).toBeEnabled());
  const target = screen.getByRole('button', { name: `Join Zebra${suffix}` });
  if (suffix) { target.focus(); await user.keyboard('{Enter}'); }
  else await user.click(target);
  expect(screen.getByRole('dialog', { name: 'Join Zebra' })).toBeVisible();
  expect(screen.getByLabelText('Room password')).toHaveFocus();
});
