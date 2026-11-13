import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { initialRoom, RoomContext, roomReducer } from './room.jsx';
import { ThemeProvider } from './shared.jsx';
import { DisplayNameForm, RoomToolbar } from './RoomControls.jsx';
import { WatchContent } from './Watch.jsx';
import { DEFAULT_PERMISSIONS } from '../js/permissions.js';

vi.mock('./Player.jsx', () => ({ Player: () => <section aria-label="Shared video">Media boundary</section> }));
vi.mock('./shared.jsx', async original => ({ ...await original(), navigate: vi.fn() }));
const stateFor = () => ({ ...initialRoom({ clientId: 'alex', clientName: 'Alex', role: 'host' }), connected: true, viewerCount: 1 });
const disconnect = vi.fn();
function wrap(state, children, send = vi.fn(() => true), attention = { current: null }) {
  return <ThemeProvider><RoomContext.Provider value={{ state, send, roomId: 'friday', disconnect, attention }}>{children}</RoomContext.Provider></ThemeProvider>;
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
  expect(screen.getByRole('button', { name: 'Leave room' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Room options' })).not.toBeInTheDocument();
  expect(screen.getAllByRole('tab')).toHaveLength(3);
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
});

it('renames the room after acknowledgment, retains failed edits, and restores focus', async () => {
  let state = stateFor(); const send = vi.fn(() => true), user = userEvent.setup();
  const view = render(wrap(state, <RoomToolbar />, send));
  const trigger = screen.getByRole('button', { name: 'Edit room name' });
  await user.click(trigger);
  const field = screen.getByRole('textbox', { name: 'Room name' });
  expect(field).toHaveFocus();
  await user.clear(field); await user.type(field, 'Friday films');
  await user.click(screen.getByRole('button', { name: 'Save name' }));
  const command = send.mock.calls[0][0];
  expect(command).toMatchObject({ type: 'set-room-name', name: 'Friday films' });
  state = roomReducer(state, { message: { type: 'error', requestId: command.requestId, message: 'Try again.' } });
  view.rerender(wrap(state, <RoomToolbar />, send));
  expect(field).toHaveValue('Friday films'); expect(field).toHaveFocus();
  expect(screen.getByRole('alert')).toHaveTextContent('Try again.');
  await user.click(screen.getByRole('button', { name: 'Save name' }));
  state = roomReducer(state, { message: { type: 'room-updated', room: { ...state.room, name: 'Friday films' } } });
  state = roomReducer(state, { message: { type: 'room-name-updated', requestId: send.mock.calls[1][0].requestId } });
  view.rerender(wrap(state, <RoomToolbar />, send));
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Friday films');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await waitFor(() => expect(trigger).toHaveFocus());
  await user.click(trigger); await user.type(screen.getByLabelText('Room name'), ' cancelled');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(send).toHaveBeenCalledTimes(2);
  view.rerender(wrap({ ...state, role: 'viewer' }, <RoomToolbar />, send));
  expect(screen.queryByRole('button', { name: 'Edit room name' })).not.toBeInTheDocument();
});

it('waits for name confirmation, prevents repeat sends, and links rejection to the visible field', async () => {
  let state = stateFor(); const send = vi.fn(() => true), user = userEvent.setup();
  const view = render(wrap(state, <DisplayNameForm />, send));
  const trigger = screen.getByRole('button', { name: 'Edit display name' });
  await user.click(trigger);
  const field = screen.getByLabelText('Your display name');
  expect(field).toHaveFocus();
  await user.clear(field); await user.type(field, 'Sam');
  await user.click(screen.getByRole('button', { name: 'Save name' }));
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'set-name', name: 'Sam' });
  expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
  expect(screen.getByRole('dialog', { name: 'Edit display name' })).toBeVisible();
  state = roomReducer(state, { message: { type: 'name-rejected', name: 'Alex', message: 'Sam is already here. Choose another name.' } });
  view.rerender(wrap(state, <DisplayNameForm />, send));
  expect(field).toHaveValue('Sam'); expect(field).toHaveFocus();
  expect(field).toHaveAccessibleDescription('Sam is already here. Choose another name.');
  await user.clear(field); await user.type(field, 'Samira'); await user.click(screen.getByRole('button', { name: 'Save name' }));
  state = roomReducer(state, { message: { type: 'name-updated', name: 'Samira' } });
  view.rerender(wrap(state, <DisplayNameForm />, send));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Samira' })).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Display name updated.');
  await waitFor(() => expect(trigger).toHaveFocus());
});

it('opens name editing only on request and discards a cancelled edit', async () => {
  const send = vi.fn(), user = userEvent.setup();
  render(wrap(stateFor(), <DisplayNameForm />, send));
  const trigger = screen.getByRole('button', { name: 'Edit display name' });
  await user.click(trigger);
  await user.clear(screen.getByLabelText('Your display name'));
  await user.type(screen.getByLabelText('Your display name'), 'Unsent name');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Alex' })).toBeVisible();
  expect(trigger).toHaveFocus(); expect(send).not.toHaveBeenCalled();
  await user.click(trigger);
  expect(screen.getByLabelText('Your display name')).toHaveValue('Alex');
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await waitFor(() => expect(trigger).toHaveFocus());
});

it('keeps display-name restrictions visible and releases pending edits on disconnect', async () => {
  let state = stateFor(); const send = vi.fn(() => true);
  const view = render(wrap(state, <DisplayNameForm />, send));
  await userEvent.click(screen.getByRole('button', { name: 'Edit display name' }));
  await userEvent.type(screen.getByLabelText('Your display name'), ' A');
  await userEvent.click(screen.getByRole('button', { name: 'Save name' }));
  state = { ...state, connected: false };
  view.rerender(wrap(state, <DisplayNameForm />, send));
  expect(screen.getByText('Reconnect before saving your name.')).toBeVisible();
  state = { ...state, role: 'viewer', permissions: { ...DEFAULT_PERMISSIONS, changeName: false } };
  view.rerender(wrap(state, <DisplayNameForm />, send));
  expect(within(screen.getByRole('dialog')).getByText('The host has disabled display-name changes.')).toBeVisible();
  expect(screen.getByLabelText('Your display name')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled();
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
  expect(screen.getByText('What are we watching next?')).toBeVisible();
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
  await user.click(screen.getByRole('button', { name: 'Start poll' }));
  expect(screen.getByRole('tab', { name: 'Up next' })).toHaveAttribute('aria-selected', 'true');
  state = { ...state, poll: { id: 'new', status: 'open' } };
  view.rerender(wrap(state, <WatchContent />, send));
  expect(screen.getByRole('textbox', { name: 'Suggest a video title' })).toBeVisible();
  await user.click(screen.getByRole('tab', { name: 'Chat' }));
  expect(screen.getByLabelText('Message')).toHaveValue('Saved draft');
  expect(screen.getByRole('button', { name: /A movie vote is open/ })).toBeVisible();
  expect(screen.queryByRole('textbox', { name: 'Suggest a video title' })).not.toBeInTheDocument();
});

it('provides a selectable invite link when clipboard access fails and restores focus on close', async () => {
  const user = userEvent.setup(); vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Denied'));
  render(wrap(stateFor(), <RoomToolbar />));
  const trigger = screen.getByRole('button', { name: 'Invite friends' }); await user.click(trigger);
  await user.click(screen.getByRole('button', { name: 'Copy invitation link' }));
  const link = screen.getByLabelText('Invitation link');
  expect(link).toHaveFocus(); expect(link.selectionStart).toBe(0); expect(link.selectionEnd).toBe(link.value.length);
  await user.click(screen.getByRole('button', { name: 'Close' })); expect(trigger).toHaveFocus();
});

it('warns the video provider before leaving and keeps failed leave attempts retryable', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Connection lost. Try again.'));
  const user = userEvent.setup(); render(wrap({ ...stateFor(), sourceOwnerId: 'alex' }, <RoomToolbar />));
  await user.click(screen.getByRole('button', { name: 'Leave room' }));
  const dialog = screen.getByRole('dialog', { name: 'Stop sharing and leave?' });
  expect(fetch).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: 'Stay in room' })).toHaveFocus();
  await user.click(within(dialog).getByRole('button', { name: 'Stop sharing and leave' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost. Try again.');
  expect(screen.getByRole('button', { name: 'Stop sharing and leave' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'Stay in room' })); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
