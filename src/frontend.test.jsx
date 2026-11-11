import React, { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Hub } from './Hub.jsx';
import { Chat } from './Chat.jsx';
import { Poll } from './Poll.jsx';
import { PermissionFields } from './Permissions.jsx';
import { initialRoom, RoomContext, roomReducer, RoomProvider, useRoom } from './room.jsx';
import { DEFAULT_PERMISSIONS } from '../js/permissions.js';
import { ThemeProvider, request } from './shared.jsx';

vi.mock('./shared.jsx', async importOriginal => ({ ...await importOriginal(), navigate: vi.fn() }));
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const room = { id: 'friday', name: 'Friday films', participantCount: 2, passwordRequired: false, watchPath: '/watch?roomId=friday' };
const identity = { clientId: 'self', clientName: 'Alex', guestName: 'Guest-SELF', role: 'viewer' };
const initial = () => initialRoom(identity);
function wrap(state, children, send = vi.fn(() => true)) {
  return <RoomContext.Provider value={{ state, send, attention: { current: { setAtLatest() {}, onChatShown() {} } } }}>{children}</RoomContext.Provider>;
}

describe('HTTP responses', () => {
  it.each([429, 503])('reports HTML proxy failures using their HTTP status (%s)', async status => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status, json: async () => { throw new SyntaxError('Unexpected token <'); } });
    await expect(request('/api/session')).rejects.toMatchObject({ status, message: `The server returned an unexpected response (HTTP ${status}). Try again shortly.` });
  });
  it('preserves cancellation while reading a response', async () => {
    const aborted = new DOMException('Aborted', 'AbortError');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 200, json: async () => { throw aborted; } });
    await expect(request('/api/session')).rejects.toBe(aborted);
  });
});

describe('React hub', () => {
  it('keeps one polling loop through StrictMode, renders room data, and cleans up requests', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response({ rooms: [room] }));
    const view = render(<StrictMode><ThemeProvider><Hub /></ThemeProvider></StrictMode>);
    expect(await screen.findByText('Friday films')).toBeVisible();
    expect(screen.getByText('2 online')).toBeVisible();
    view.unmount();
    expect(fetch.mock.calls.every(([, options]) => options.signal.aborted)).toBe(true);
  });
  it('validates whitespace names and creates a room using the display name', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => response(url === '/api/rooms' && !options.method ? { rooms: [] } : url === '/api/viewer-identity' ? {} : { room }));
    const user = userEvent.setup();
    render(<ThemeProvider><Hub /></ThemeProvider>);
    await screen.findByText('No rooms yet. Create a room to start watching.');
    await user.type(screen.getByLabelText(/Your name/), 'Sam');
    await user.click(screen.getByRole('button', { name: /Create room/ }));
    await user.type(screen.getByLabelText('Room name'), '   ');
    await user.click(screen.getByRole('button', { name: 'Create room' }));
    expect(screen.getByText('Enter a room name.')).toBeVisible();
    await user.clear(screen.getByLabelText('Room name')); await user.type(screen.getByLabelText('Room name'), 'Movie night');
    await user.click(screen.getByRole('button', { name: 'Create room' }));
    await waitFor(() => expect(fetch.mock.calls.some(([url, options]) => url === '/api/rooms' && options.method === 'POST' && JSON.parse(options.body).displayName === 'Sam')).toBe(true));
  });
  it('preserves a protected-room password after a rejection and allows retry', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => url === '/api/rooms' ? response({ rooms: [{ ...room, passwordRequired: true }] }) : url.endsWith('/api/session') ? response({ error: 'Join first.' }, 401) : url === '/api/rooms/join' ? response({ error: 'Incorrect room password.' }, 401) : response({}));
    const user = userEvent.setup(); render(<ThemeProvider><Hub /></ThemeProvider>);
    await user.click(await screen.findByRole('button', { name: 'Join Friday films' }));
    await user.type(screen.getByLabelText('Room password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Join room' }));
    expect(await screen.findByText('Incorrect room password.')).toBeVisible();
    expect(screen.getByLabelText('Room password')).toHaveValue('secret');
    expect(screen.getByRole('button', { name: 'Join room' })).toBeEnabled();
  });
  it('shows directory failure, retries, and reports expired invitations', async () => {
    history.replaceState(null, '', '/?room=gone');
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(response({ rooms: [] }));
    const user = userEvent.setup(); render(<ThemeProvider><Hub /></ThemeProvider>);
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('That room is no longer available. Choose another room or create your own.')).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('changes theme even when preference storage is unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ rooms: [] }));
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Denied'); });
    render(<ThemeProvider><Hub /></ThemeProvider>);
    await userEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }));
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

describe('React room workflows', () => {
  it('keeps sent messages on the right across reconnects and identity updates', () => {
    let state = { ...initial(), connected: true };
    const receive = message => { state = roomReducer(state, { message }); };
    receive({ type: 'chat', commentId: 'before', clientId: 'self', name: 'Alex', message: 'Before reconnect' });
    // A matching display name must never identify another participant as us.
    receive({ type: 'chat', commentId: 'other', clientId: 'other', name: 'Alex', message: 'Another participant' });
    const view = render(wrap(state, <Chat overlayTarget={document.body} layoutKey="normal" />));
    const assertSides = () => {
      expect(screen.getByText('Before reconnect').closest('article')).toHaveClass('self');
      expect(screen.getByText('Another participant').closest('article')).not.toHaveClass('self');
    };
    assertSides();
    state = roomReducer(state, { type: 'status', connected: false, text: 'Disconnected' });
    view.rerender(wrap(state, <Chat overlayTarget={document.body} layoutKey="normal" />));
    assertSides();
    receive({ type: 'role', clientId: 'reconnected', name: 'Alex', role: 'viewer' });
    state = roomReducer(state, { type: 'status', connected: true, text: 'Connected' });
    receive({ type: 'chat', commentId: 'after', clientId: 'reconnected', name: 'Alex', message: 'After reconnect' });
    view.rerender(wrap(state, <Chat overlayTarget={document.body} layoutKey="normal" />));
    assertSides();
    expect(screen.getByText('After reconnect').closest('article')).toHaveClass('self');
    receive({ type: 'name-updated', name: 'Renamed' });
    receive({ type: 'role', clientId: 'reconnected', name: 'Renamed', role: 'host' });
    receive({ type: 'comment-reaction', commentId: 'before', reactions: [{ clientId: 'other', name: 'Alex', emoji: '👍' }], myReaction: null });
    view.rerender(wrap(state, <Chat overlayTarget={document.body} layoutKey="normal" />));
    assertSides();
    expect(screen.getByText('After reconnect').closest('article')).toHaveClass('self');
    expect(state.messages.find(item => item.commentId === 'before').reactions).toHaveLength(1);
    expect(state.messages.filter(item => !item.system).map(item => item.isOwn)).toEqual([true, false, true]);
  });
  it.each([undefined, null, ''])('does not assign ownership without a valid identity (%s)', clientId => {
    const state = roomReducer(initialRoom({ ...identity, clientId }), {
      message: { type: 'chat', commentId: 'unknown', clientId, name: 'Alex', message: 'Unidentified', isOwn: true },
    });
    expect(state.messages.find(item => item.commentId === 'unknown').isOwn).toBe(false);
  });
  it('waits for chat acknowledgments and preserves an edited draft', async () => {
    const send = vi.fn(() => true), overlay = document.createElement('div'); document.body.appendChild(overlay);
    let state = { ...initial(), connected: true };
    const view = render(wrap(state, <Chat overlayTarget={overlay} layoutKey="normal" />, send));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Message'), 'Hello'); await user.click(screen.getByLabelText('Send message'));
    expect(screen.getByLabelText('Message')).toHaveValue('Hello');
    const sent = send.mock.calls[0][0];
    await user.type(screen.getByLabelText('Message'), ' again');
    state = roomReducer(state, { message: { ...sent, type: 'chat', commentId: 'one', clientId: 'self', name: 'Alex', time: '12:00' } });
    state = roomReducer(state, { message: { type: 'presence', count: 2, participants: [] } });
    view.rerender(wrap(state, <Chat overlayTarget={overlay} layoutKey="normal" />, send));
    expect(screen.getByLabelText('Message')).toHaveValue('Hello again');
    expect(screen.getByText('Hello', { selector: 'p' })).toBeVisible();
    overlay.remove();
  });
  it('retains drafts on rejection and disconnect, and applies permission changes', async () => {
    const send = vi.fn(() => true), overlay = document.body;
    let state = { ...initial(), connected: true };
    const view = render(wrap(state, <Chat overlayTarget={overlay} layoutKey="normal" />, send));
    await userEvent.type(screen.getByLabelText('Message'), 'Keep me'); await userEvent.click(screen.getByLabelText('Send message'));
    state = roomReducer(state, { message: { type: 'error', action: 'chat', requestId: send.mock.calls[0][0].requestId, message: 'Try again later.' } });
    view.rerender(wrap(state, <Chat overlayTarget={overlay} layoutKey="normal" />, send));
    expect(screen.getByText('Try again later.')).toBeVisible();
    state = { ...state, connected: false, permissions: { ...DEFAULT_PERMISSIONS, sendChat: false } };
    view.rerender(wrap(state, <Chat overlayTarget={overlay} layoutKey="normal" />, send));
    expect(screen.getByLabelText('Message')).toHaveValue('Keep me'); expect(screen.getByLabelText('Send message')).toBeDisabled();
  });
  it('renders server reaction snapshots and allows quoted replies through message actions', async () => {
    const send = vi.fn(() => true);
    let state = { ...initial(), connected: true };
    state = roomReducer(state, { message: { type: 'chat', commentId: 'one', name: 'Sam', message: 'Hello', clientId: 'other', time: '12:00' } });
    state = roomReducer(state, { message: { type: 'comment-reaction', commentId: 'one', reactions: [{ clientId: 'self', name: 'Alex', emoji: '👍' }], myReaction: '👍' } });
    render(wrap(state, <Chat overlayTarget={document.body} layoutKey="normal" />, send));
    await userEvent.click(screen.getByRole('button', { name: /👍, 1 reactions/ }));
    expect(send).toHaveBeenCalledWith({ type: 'comment-reaction', commentId: 'one', emoji: null });
    fireEvent.contextMenu(screen.getByText('Hello').closest('article'));
    await userEvent.click(screen.getByRole('menuitem', { name: /Reply/ }));
    expect(screen.getByText('Reply to Sam')).toBeVisible();
  });
  it('supports movie search failures, title-only suggestions, and replacing votes', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Search unavailable.'));
    const state = { ...initial(), connected: true, poll: { id: 'poll', status: 'open' }, suggestions: [{ id: 'arrival', title: 'Arrival', votes: 1, canRemove: true }], myVoteId: null };
    const send = vi.fn(() => true); render(wrap(state, <Poll expanded onToggle={() => {}} />, send));
    await userEvent.type(screen.getByLabelText('Suggest a video title'), 'Dune'); await userEvent.click(screen.getByText('Find movie'));
    await userEvent.click(await screen.findByText('Suggest “Dune” without a poster'));
    expect(send).toHaveBeenCalledWith({ type: 'suggest-video', title: 'Dune', pollId: 'poll' });
    await userEvent.click(screen.getByLabelText('Vote for Arrival'));
    expect(send).toHaveBeenCalledWith({ type: 'vote-video', suggestionId: 'arrival', pollId: 'poll' });
  });
  it('renders every room permission and emits an override reset', async () => {
    const change = vi.fn(); render(<PermissionFields values={DEFAULT_PERMISSIONS} person="Sam" overrides={{ seek: true }} onChange={change} />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(19);
    await userEvent.click(screen.getByLabelText('Use room default for Seek'));
    expect(change).toHaveBeenCalledWith({ seek: null });
  });
  it('bounds retained messages and preserves same-browser moderation markers', () => {
    let state = initial();
    for (let i = 0; i < 510; i++) state = roomReducer(state, { message: { type: 'chat', commentId: `m${i}`, message: 'test' } });
    expect(state.messages).toHaveLength(500); expect(state.messages[0].commentId).toBe('m10');
    state = roomReducer(state, { message: { type: 'presence', count: 1, participants: [{ clientId: 'one', sameBrowser: true }] } });
    state = roomReducer(state, { message: { type: 'party-state', participants: [{ clientId: 'one' }] } });
    expect(state.people[0].sameBrowser).toBe(true);
    state = roomReducer(state, { message: { type: 'session-state', sourceOwnerId: 'one' } });
    state = roomReducer(state, { message: { type: 'session-state', sourceOwnerId: null } });
    expect(state.sourceOwnerId).toBeNull();
  });
  it('aborts admission during StrictMode remount and opens only one live connection', async () => {
    const sockets = [];
    class Socket {
      static OPEN = 1;
      constructor() { this.handlers = {}; this.readyState = 1; sockets.push(this); }
      addEventListener(type, fn) { this.handlers[type] = fn; }
      send() {} close() { this.readyState = 3; }
    }
    vi.stubGlobal('WebSocket', Socket);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options = {}) => {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return response(url === '/api/session' ? { room, endpoints: { websocket: '/ws' } } : {});
    });
    function Probe() { const { state } = useRoom(); return <p>{state.room.name}</p>; }
    const view = render(<StrictMode><RoomProvider><Probe /></RoomProvider></StrictMode>);
    await screen.findByText('Friday films');
    expect(sockets).toHaveLength(1);
    view.unmount(); expect(sockets[0].readyState).toBe(3);
    vi.unstubAllGlobals();
  });
});
