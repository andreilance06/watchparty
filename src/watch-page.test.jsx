import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { initialRoom, RoomContext, roomReducer } from './room.jsx';
import { ThemeProvider } from './shared.jsx';
import { DisplayNameForm, RoomIdentity, RoomActions, RoomHeader } from './RoomControls.jsx';
import { navigate } from './shared.jsx';
import { WatchContent } from './Watch.jsx';
import { DEFAULT_PERMISSIONS } from '../js/permissions.js';
import { CHAT_DOCK_KEY } from './chat-dock.js';

vi.mock('./Player.jsx', () => ({ Player: () => <section aria-label="Shared video">Media boundary</section> }));
vi.mock('./shared.jsx', async original => ({ ...await original(), navigate: vi.fn() }));
const stateFor = () => ({ ...initialRoom({ clientId: 'alex', clientName: 'Alex', role: 'host' }), connected: true, connectionText: 'Connected', viewerCount: 1 });
const disconnect = vi.fn();
function wrap(state, children, send = vi.fn(() => true), attention = { current: null }) {
  return <ThemeProvider><RoomContext.Provider value={{ state, send, roomId: 'friday', disconnect, attention }}>{children}</RoomContext.Provider></ThemeProvider>;
}
function attemptUnload() {
  const event = new Event('beforeunload', { cancelable: true });
  // Model BeforeUnloadEvent's legacy value separately from Event's boolean returnValue alias.
  Object.defineProperty(event, 'returnValue', { value: '', writable: true });
  window.dispatchEvent(event); return event;
}

it('exposes identity and room actions without opening an options menu', () => {
  render(wrap(stateFor(), <WatchContent />));
  expect(screen.getByRole('heading', { name: 'Alex', level: 2 })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Edit display name' })).toBeVisible();
  expect(screen.queryByRole('textbox', { name: 'Your display name' })).not.toBeInTheDocument();
  expect(screen.queryByText(/the shared screen|the lounge|good company/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/people here|person here/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Invite friends' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Room permissions' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Leave room' })).not.toBeInTheDocument();
  const header = screen.getByRole('banner'), identity = screen.getByRole('heading', { name: 'Alex' }).closest('.chat-heading');
  expect(within(header).getByRole('heading', { level: 1 })).toBeVisible();
  expect(within(header).getByText('Connected')).toBeVisible();
  expect(within(identity).getByRole('button', { name: 'Invite friends' })).toHaveTextContent('');
  expect(within(identity).getByRole('button', { name: 'Room permissions' })).toHaveTextContent('');
  expect(screen.queryByRole('button', { name: 'Room options' })).not.toBeInTheDocument();
  expect(screen.getAllByRole('tab')).toHaveLength(3);
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
});

it.each(['WatchParty', 'Browse rooms'])('confirms %s navigation for the provider and keeps cancellation harmless', async target => {
  const user = userEvent.setup(), fetch = vi.spyOn(globalThis, 'fetch');
  render(wrap({ ...stateFor(), sourceOwnerId: 'alex', role: 'viewer', media: { hasVideo: true } }, <RoomHeader />));
  const link = screen.getByRole('link', { name: target }); await user.click(link);
  const dialog = screen.getByRole('dialog', { name: 'Stop sharing and leave?' });
  expect(dialog).toHaveTextContent('Leaving will stop playback for everyone');
  expect(screen.getByRole('button', { name: 'Stay in room' })).toHaveFocus();
  expect(fetch).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Stay in room' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await waitFor(() => expect(link).toHaveFocus());
  expect(attemptUnload().defaultPrevented).toBe(true);
  await user.click(link); fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(fetch).not.toHaveBeenCalled();
});

it.each(['WatchParty', 'Browse rooms'])('keeps a failed leave through %s retryable and disconnects only after confirmation succeeds', async target => {
  let resolveLeave;
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Connection lost. Try again.'))
    .mockImplementationOnce(() => new Promise(resolve => { resolveLeave = resolve; }));
  const user = userEvent.setup(); disconnect.mockClear(); vi.mocked(navigate).mockClear();
  render(wrap({ ...stateFor(), sourceOwnerId: 'alex', media: { processing: true } }, <RoomHeader />));
  await user.click(screen.getByRole('link', { name: target }));
  await user.click(screen.getByRole('button', { name: 'Stop sharing and leave' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost. Try again.');
  expect(disconnect).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
  expect(attemptUnload().defaultPrevented).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Stop sharing and leave' }));
  expect(screen.getByRole('button', { name: 'Leaving…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Stay in room' })).toBeDisabled();
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(fetch).toHaveBeenLastCalledWith('/rooms/friday/api/leave', expect.objectContaining({ method: 'POST' }));
  await act(async () => { resolveLeave({ ok: true, json: async () => ({ left: true }) }); });
  expect(fetch).toHaveBeenCalledTimes(2); expect(disconnect).toHaveBeenCalledTimes(1); expect(navigate).toHaveBeenCalledWith('/');
  expect(attemptUnload().defaultPrevented).toBe(false);
});

it('guards browser refresh/close only while supplying video, including after transferring hosting', () => {
  let state = stateFor(); disconnect.mockClear();
  const fetch = vi.spyOn(globalThis, 'fetch');
  const view = render(wrap(state, <RoomHeader />));
  expect(attemptUnload().defaultPrevented).toBe(false);
  state = { ...state, role: 'viewer', sourceOwnerId: 'sam', media: { hasVideo: true } };
  view.rerender(wrap(state, <RoomHeader />)); expect(attemptUnload().defaultPrevented).toBe(false);
  state = { ...state, sourceOwnerId: 'alex', role: 'host' }; view.rerender(wrap(state, <RoomHeader />));
  const attempt = attemptUnload();
  expect(attempt.defaultPrevented).toBe(true); expect(attempt.returnValue).toBe(true);
  expect(fetch).not.toHaveBeenCalled(); expect(disconnect).not.toHaveBeenCalled();
  state = { ...state, role: 'viewer' }; view.rerender(wrap(state, <RoomHeader />));
  expect(attemptUnload().defaultPrevented).toBe(true);
  state = { ...state, sourceOwnerId: null, media: { hasVideo: false } }; view.rerender(wrap(state, <RoomHeader />));
  expect(attemptUnload().defaultPrevented).toBe(false);
  view.rerender(wrap({ ...state, sourceOwnerId: 'alex' }, <RoomHeader />));
  expect(attemptUnload().defaultPrevented).toBe(true);
  view.unmount(); expect(attemptUnload().defaultPrevented).toBe(false);
});

it('protects a provider reported by presence while preparing video and removes protection on disconnect', () => {
  const state = { ...stateFor(), role: 'viewer', media: { processing: true }, people: [{ clientId: 'alex', suppliesVideo: true }] };
  const view = render(wrap(state, <RoomHeader />));
  expect(attemptUnload().defaultPrevented).toBe(true);
  view.rerender(wrap({ ...state, connected: false }, <RoomHeader />));
  expect(attemptUnload().defaultPrevented).toBe(false);
  view.rerender(wrap(state, <RoomHeader />)); expect(attemptUnload().defaultPrevented).toBe(true);
  view.rerender(wrap({ ...state, people: [], media: { hasVideo: false } }, <RoomHeader />));
  expect(attemptUnload().defaultPrevented).toBe(false);
});

it.each(['WatchParty', 'Browse rooms'])('confirms active viewer playback through %s and preserves idle/modified navigation', async target => {
  const user = userEvent.setup(), state = { ...stateFor(), role: 'viewer', sourceOwnerId: 'sam', media: { hasVideo: true } };
  const view = render(wrap(state, <RoomHeader />));
  const link = screen.getByRole('link', { name: target });
  const navigateClick = options => {
    let prevented;
    const inspect = event => { prevented = event.defaultPrevented; event.preventDefault(); };
    document.addEventListener('click', inspect, { once: true }); fireEvent.click(link, options); return prevented;
  };
  expect(navigateClick({ ctrlKey: true })).toBe(false);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await user.click(link);
  expect(screen.getByRole('dialog', { name: 'Leave watch party?' })).not.toHaveTextContent('stop playback for everyone');
  await user.click(screen.getByRole('button', { name: 'Stay in room' }));
  view.rerender(wrap({ ...state, media: { hasVideo: false } }, <RoomHeader />));
  expect(navigateClick()).toBe(false); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('collapses and reopens the dock without losing the draft, selected tab, or media boundary', async () => {
  const user = userEvent.setup(); render(wrap(stateFor(), <WatchContent />));
  const media = screen.getByRole('region', { name: 'Shared video' });
  const message = screen.getByLabelText('Message'); await user.type(message, 'Keep my place');
  await user.click(screen.getByRole('tab', { name: /People/ }));
  const toggle = screen.getByRole('button', { name: 'Hide chat' });
  await user.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'false'); expect(toggle).toHaveFocus();
  expect(screen.queryByRole('complementary', { name: 'Chatroom' })).not.toBeInTheDocument();
  expect(document.getElementById('watchChatroom')).toHaveAttribute('hidden');
  await user.click(screen.getByRole('button', { name: 'Show chat' }));
  expect(screen.getByRole('tab', { name: /People/ })).toHaveAttribute('aria-selected', 'true');
  await user.click(screen.getByRole('tab', { name: 'Chat' }));
  expect(screen.getByLabelText('Message')).toBe(message); expect(message).toHaveValue('Keep my place');
  expect(screen.getByRole('region', { name: 'Shared video' })).toBe(media);
  message.focus(); await user.keyboard('{Escape}');
  expect(toggle).toHaveFocus(); expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

it('keeps hidden chat unread until reopened and exposes the count on the edge button', async () => {
  const attention = { current: null }, user = userEvent.setup();
  render(wrap(stateFor(), <WatchContent />, vi.fn(), attention));
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(document.getElementById('chatMessages'), 'getBoundingClientRect').mockReturnValue({ width: 300, height: 200, top: 100, bottom: 300 });
  await user.click(screen.getByRole('button', { name: 'Hide chat' }));
  act(() => { attention.current.receiveMessage({ name: 'Sam', message: 'Look at this scene' }); attention.current.refresh(); });
  const toggle = screen.getByRole('button', { name: 'Show chat, 1 unread message' });
  expect(within(toggle).getByText('1')).toBeVisible();
  await user.click(toggle);
  expect(screen.getByRole('tab', { name: 'Chat' })).toBeVisible();
  expect(toggle).toHaveAccessibleName('Hide chat');
});

const dockWidth = () => document.querySelector('.watch-theater').style.getPropertyValue('--chat-width');
const dockButton = () => screen.getByRole('button', { name: /^(Hide|Show) chat/ });
it('remembers dock width and closed state across visits, with keyboard sizing on the toggle', async () => {
  const user = userEvent.setup(), view = render(wrap(stateFor(), <WatchContent />));
  dockButton().focus(); await user.keyboard('{ArrowLeft}{ArrowLeft}');
  expect(dockWidth()).toBe('412px');
  await user.click(dockButton());
  expect(JSON.parse(localStorage.getItem(CHAT_DOCK_KEY))).toEqual({ open: false, width: 412 });
  view.unmount(); render(wrap(stateFor(), <WatchContent />));
  await user.click(dockButton()); expect(dockWidth()).toBe('412px');
  dockButton().focus(); await user.keyboard('{Home}'); expect(dockWidth()).toBe('320px');
  await user.keyboard('{End}'); expect(parseInt(dockWidth())).toBeGreaterThan(412);
});

it('resizes with the toggle without collapsing on release, and cancels an interrupted drag', () => {
  render(wrap(stateFor(), <WatchContent />));
  const toggle = dockButton();
  toggle.setPointerCapture = vi.fn(); toggle.hasPointerCapture = () => true; toggle.releasePointerCapture = vi.fn();
  const pointer = (type, x) => {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: 7 }); fireEvent(toggle, event);
  };
  pointer('pointerdown', 700); pointer('pointermove', 600);
  expect(toggle.setPointerCapture).toHaveBeenCalledWith(7); expect(dockWidth()).toBe('480px');
  expect(JSON.parse(localStorage.getItem(CHAT_DOCK_KEY)).width).toBe(380);
  pointer('pointerup', 600); fireEvent.click(toggle, { detail: 1 });
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(JSON.parse(localStorage.getItem(CHAT_DOCK_KEY)).width).toBe(480);
  expect(toggle.releasePointerCapture).toHaveBeenCalledWith(7);
  pointer('pointerdown', 600); pointer('pointermove', 2000); expect(dockWidth()).toBe('320px');
  pointer('pointercancel', 2000); fireEvent.click(toggle, { detail: 1 });
  expect(dockWidth()).toBe('480px'); expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const originalWidth = window.innerWidth;
  try {
    pointer('pointerdown', 600); pointer('pointermove', 500);
    window.innerWidth = 375; fireEvent(window, new Event('resize'));
    expect(document.querySelector('.watch-theater')).not.toHaveClass('is-resizing');
    expect(JSON.parse(localStorage.getItem(CHAT_DOCK_KEY)).width).toBe(480);
  } finally { window.innerWidth = originalWidth; }
});

it('treats slight pointer movement as a click and lets a leftward drag reopen closed chat', () => {
  render(wrap(stateFor(), <WatchContent />)); const toggle = dockButton();
  const pointer = (type, x) => {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: 7 }); fireEvent(toggle, event);
  };
  pointer('pointerdown', 700); pointer('pointermove', 698); pointer('pointerup', 698);
  fireEvent.click(toggle, { detail: 1 }); expect(toggle).toHaveAttribute('aria-expanded', 'false');
  pointer('pointerdown', 1000); pointer('pointermove', 650); pointer('pointerup', 650);
  fireEvent.click(toggle, { detail: 1 });
  expect(toggle).toHaveAttribute('aria-expanded', 'true'); expect(dockWidth()).toBe('350px');
  expect(screen.queryByRole('separator')).not.toBeInTheDocument();
});

it('handles invalid preferences and retains preferred width through narrow layouts', () => {
  localStorage.setItem(CHAT_DOCK_KEY, 'not JSON');
  const view = render(wrap(stateFor(), <WatchContent />)); expect(dockWidth()).toBe('380px'); view.unmount();
  localStorage.setItem(CHAT_DOCK_KEY, JSON.stringify({ open: true, width: 640 }));
  const originalWidth = window.innerWidth;
  try {
    window.innerWidth = 800; render(wrap(stateFor(), <WatchContent />)); expect(dockWidth()).toBe('480px');
    window.innerWidth = 375; fireEvent(window, new Event('resize'));
    expect(dockButton()).not.toHaveAttribute('aria-describedby');
    expect(JSON.parse(localStorage.getItem(CHAT_DOCK_KEY)).width).toBe(640);
    window.innerWidth = 1440; fireEvent(window, new Event('resize')); expect(dockWidth()).toBe('640px');
  } finally { window.innerWidth = originalWidth; }
});

it('renames the room after acknowledgment, retains failed edits, and restores focus', async () => {
  let state = stateFor(); const send = vi.fn(() => true), user = userEvent.setup();
  const view = render(wrap(state, <RoomIdentity />, send));
  const trigger = screen.getByRole('button', { name: 'Edit room name' });
  await user.click(trigger);
  const field = screen.getByRole('textbox', { name: 'Room name' });
  expect(field).toHaveFocus();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await user.clear(field); await user.type(field, 'Friday films');
  await user.click(screen.getByRole('button', { name: 'Save room name' }));
  const command = send.mock.calls[0][0];
  expect(command).toMatchObject({ type: 'set-room-name', name: 'Friday films' });
  expect(screen.getByRole('button', { name: 'Saving room name' })).toBeDisabled();
  expect(field).toHaveAttribute('readonly');
  await user.click(field); await user.keyboard('{Escape}'); expect(field).toBeInTheDocument();
  state = roomReducer(state, { message: { type: 'error', requestId: command.requestId, message: 'Try again.' } });
  view.rerender(wrap(state, <RoomIdentity />, send));
  expect(field).toHaveValue('Friday films'); expect(field).toHaveFocus();
  expect(screen.getByRole('alert')).toHaveTextContent('Try again.');
  expect(field).toHaveAccessibleDescription('Try again.');
  await user.keyboard('{Enter}');
  state = roomReducer(state, { message: { type: 'room-updated', room: { ...state.room, name: 'Friday films' } } });
  state = roomReducer(state, { message: { type: 'room-name-updated', requestId: send.mock.calls[1][0].requestId } });
  view.rerender(wrap(state, <RoomIdentity />, send));
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Friday films');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await waitFor(() => expect(trigger).toHaveFocus());
  await user.click(trigger); await user.type(screen.getByLabelText('Room name'), ' cancelled');
  await user.keyboard('{Escape}');
  expect(send).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('textbox', { name: 'Room name' })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  view.rerender(wrap({ ...state, role: 'viewer' }, <RoomIdentity />, send));
  expect(screen.queryByRole('button', { name: 'Edit room name' })).not.toBeInTheDocument();
});

it('validates inline room names and removes editing access after a host change', async () => {
  const send = vi.fn(() => true), user = userEvent.setup(); let state = stateFor();
  const view = render(wrap(state, <RoomIdentity />, send));
  await user.click(screen.getByRole('button', { name: 'Edit room name' }));
  const input = screen.getByRole('textbox', { name: 'Room name' });
  await user.clear(input); await user.type(input, '   {Enter}');
  expect(screen.getByRole('alert')).toHaveTextContent('Enter a room name of at most 80 characters.');
  expect(input).toHaveFocus(); expect(send).not.toHaveBeenCalled();
  state = { ...state, connected: false }; view.rerender(wrap(state, <RoomIdentity />, send));
  expect(screen.getByRole('button', { name: 'Save room name' })).toBeDisabled();
  state = { ...state, connected: true, role: 'viewer' }; view.rerender(wrap(state, <RoomIdentity />, send));
  expect(screen.queryByRole('textbox', { name: 'Room name' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Edit room name' })).not.toBeInTheDocument();
});

it('edits the name inline, waits for acknowledgment, and preserves rejected edits', async () => {
  let state = stateFor(); const send = vi.fn(() => true), user = userEvent.setup();
  const view = render(wrap(state, <DisplayNameForm />, send));
  const trigger = screen.getByRole('button', { name: 'Edit display name' }); await user.click(trigger);
  const field = screen.getByLabelText('Your display name');
  expect(field).toHaveFocus(); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Alex' })).not.toBeInTheDocument();
  await user.clear(field); await user.type(field, 'Sam');
  await user.click(screen.getByRole('button', { name: 'Save display name' }));
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'set-name', name: 'Sam' });
  expect(screen.getByRole('button', { name: 'Saving display name' })).toBeDisabled();
  expect(field).toHaveAttribute('readonly');
  await user.click(field); await user.keyboard('{Escape}'); expect(field).toBeInTheDocument();
  state = roomReducer(state, { message: { type: 'name-rejected', name: 'Alex', message: 'Sam is already here. Choose another name.' } });
  view.rerender(wrap(state, <DisplayNameForm />, send));
  expect(field).toHaveValue('Sam'); expect(field).toHaveFocus();
  expect(field).toHaveAccessibleDescription('Sam is already here. Choose another name.');
  await user.clear(field); await user.type(field, 'Samira{Enter}');
  state = roomReducer(state, { message: { type: 'name-updated', name: 'Samira' } });
  view.rerender(wrap(state, <DisplayNameForm />, send));
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Samira' })).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Display name updated.');
  await waitFor(() => expect(trigger).toHaveFocus());
});

it('cancels inline edits with Escape without hiding chat, and validates blank names', async () => {
  const send = vi.fn(), user = userEvent.setup(); render(wrap(stateFor(), <WatchContent />, send));
  const trigger = screen.getByRole('button', { name: 'Edit display name' }); await user.click(trigger);
  const field = screen.getByLabelText('Your display name'); await user.clear(field); await user.type(field, 'Unsent name');
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('textbox', { name: 'Your display name' })).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Alex' })).toBeVisible();
  expect(trigger).toHaveFocus(); expect(send).not.toHaveBeenCalled();
  expect(dockButton()).toHaveAttribute('aria-expanded', 'true');
  await user.click(trigger); expect(screen.getByLabelText('Your display name')).toHaveValue('Alex');
  await user.clear(screen.getByLabelText('Your display name')); await user.keyboard('   {Enter}');
  expect(screen.getByRole('alert')).toHaveTextContent('Enter a display name.'); expect(send).not.toHaveBeenCalled();
});

it('keeps name restrictions visible and releases pending edits on disconnect', async () => {
  let state = stateFor(); const send = vi.fn(() => true), user = userEvent.setup();
  const view = render(wrap(state, <DisplayNameForm />, send));
  await user.click(screen.getByRole('button', { name: 'Edit display name' }));
  await user.type(screen.getByLabelText('Your display name'), ' A');
  await user.click(screen.getByRole('button', { name: 'Save display name' }));
  state = { ...state, connected: false }; view.rerender(wrap(state, <DisplayNameForm />, send));
  expect(screen.getByText('Reconnect before saving your name.')).toBeVisible();
  state = { ...state, role: 'viewer', permissions: { ...DEFAULT_PERMISSIONS, changeName: false } };
  view.rerender(wrap(state, <DisplayNameForm />, send));
  expect(screen.getByText('The host has disabled display-name changes.')).toBeVisible();
  expect(screen.getByLabelText('Your display name')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Save display name' })).toBeDisabled();
});

it('shows participant and unread counts on their tabs and clears unread when chat is read', async () => {
  const attention = { current: null }, user = userEvent.setup();
  render(wrap({ ...stateFor(), viewerCount: 3 }, <WatchContent />, vi.fn(), attention));
  expect(within(screen.getByRole('tab', { name: 'People, 3 participants' })).getByText('3')).toBeVisible();
  expect(screen.getByRole('tab', { name: 'Chat' }).querySelector('.watch-tab-count')).toBeNull();
  await user.click(screen.getByRole('tab', { name: /People/ }));
  act(() => {
    attention.current.receiveMessage({ name: 'Sam', message: 'Ready?' });
    attention.current.receiveMessage({ name: 'Sam', message: 'Let’s watch.' });
  });
  expect(within(screen.getByRole('tab', { name: 'Chat, 2 unread messages' })).getByText('2')).toBeVisible();
  expect(screen.getByText('2 unread messages')).toHaveAttribute('role', 'status');
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(document.getElementById('chatMessages'), 'getBoundingClientRect').mockReturnValue({ width: 300, height: 200, top: 100, bottom: 300 });
  await user.click(screen.getByRole('tab', { name: /Chat, 2 unread/ }));
  expect(screen.getByRole('tab', { name: 'Chat' }).querySelector('.watch-tab-count')).toBeNull();
});

it('preserves the conversation and media boundary across all lounge tabs and supports keyboard navigation', async () => {
  render(wrap(stateFor(), <WatchContent />));
  const user = userEvent.setup(), video = screen.getByRole('region', { name: 'Shared video' });
  const message = screen.getByLabelText('Message'); await user.type(message, 'Keep this draft');
  await user.click(screen.getByRole('tab', { name: /People/ }));
  expect(screen.getByRole('tabpanel', { name: /People/ })).toBeVisible();
  await user.keyboard('{ArrowRight}');
  expect(screen.getByRole('tab', { name: 'Up next' })).toHaveFocus();
  expect(screen.getByText('What’s next?')).toBeVisible();
  await user.keyboard('{Home}');
  expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByLabelText('Message')).toBe(message);
  expect(message).toHaveValue('Keep this draft');
  expect(screen.getByRole('region', { name: 'Shared video' })).toBe(video);
});

it('opens a newly started poll in Up next while keeping the chat draft mounted', async () => {
  let state = stateFor(); const send = vi.fn(() => true), user = userEvent.setup();
  const view = render(wrap(state, <WatchContent />, send));
  await user.type(screen.getByLabelText('Message'), 'Saved draft');
  expect(screen.queryByRole('button', { name: 'Start poll' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Live reactions' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('tab', { name: 'Up next' }));
  await user.click(screen.getByRole('button', { name: 'Start poll' }));
  expect(screen.getByRole('tab', { name: 'Up next' })).toHaveAttribute('aria-selected', 'true');
  state = { ...state, poll: { id: 'new', status: 'open' } };
  view.rerender(wrap(state, <WatchContent />, send));
  expect(screen.getByRole('textbox', { name: 'Movie title' })).toBeVisible();
  await user.click(screen.getByRole('tab', { name: 'Chat' }));
  expect(screen.getByLabelText('Message')).toHaveValue('Saved draft');
  expect(screen.getByRole('button', { name: /A movie vote is open/ })).toBeVisible();
  expect(screen.queryByRole('textbox', { name: 'Movie title' })).not.toBeInTheDocument();
});

it('provides a selectable invite link when clipboard access fails and restores focus on close', async () => {
  const user = userEvent.setup(); vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Denied'));
  render(wrap(stateFor(), <RoomActions />));
  const trigger = screen.getByRole('button', { name: 'Invite friends' }); await user.click(trigger);
  await user.click(screen.getByRole('button', { name: 'Copy invitation link' }));
  const link = screen.getByLabelText('Invitation link');
  expect(link).toHaveFocus(); expect(link.selectionStart).toBe(0); expect(link.selectionEnd).toBe(link.value.length);
  await user.click(screen.getByRole('button', { name: 'Close' })); expect(trigger).toHaveFocus();
});
