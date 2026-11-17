import React, { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { Chat } from './Chat.jsx';
import { Participants } from './Permissions.jsx';
import { Poll, PollLauncher } from './Poll.jsx';
import { DEFAULT_PERMISSIONS } from '../js/permissions.js';
import { initialRoom, RoomContext, roomReducer } from './room.jsx';

const viewer = { clientId: 'sam', name: 'Sam', role: 'viewer', permissions: DEFAULT_PERMISSIONS, permissionOverrides: {} };
const hostState = () => ({ ...initialRoom({ clientId: 'alex', clientName: 'Alex', role: 'host' }), connected: true, people: [viewer] });
function wrap(state, child, send = vi.fn(() => true)) {
  return <RoomContext.Provider value={{ state, send, attention: { current: { setAtLatest() {}, onChatShown() {} } } }}>{child}</RoomContext.Provider>;
}
const personButton = () => screen.getByRole('button', { name: /Sam.*Viewer/ });

it('searches and submits a TMDB movie selection with its poster and release year', async () => {
  const movie = { tmdbId: 329865, title: 'Arrival (2016)', description: 'A science fiction film.', pageUrl: 'https://www.themoviedb.org/movie/329865', posterUrl: 'https://image.tmdb.org/t/p/w342/poster.jpg' };
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ movies: [movie] }) });
  const user = userEvent.setup(), send = vi.fn(() => true);
  render(wrap({ ...hostState(), poll: { id: 'poll', status: 'open' } }, <Poll expanded disclosure={false} />, send));
  await user.type(screen.getByLabelText('Movie title'), 'Arrival');
  await user.click(screen.getByRole('button', { name: 'Search', exact: true }));
  expect(fetch).toHaveBeenCalledWith('/api/movies/search?q=Arrival', expect.any(Object));
  expect(await screen.findByRole('heading', { name: 'Arrival (2016)' })).toBeVisible();
  expect(screen.getByRole('img', { name: 'Poster for Arrival (2016)' })).toHaveAttribute('src', movie.posterUrl);
  await user.click(screen.getByRole('button', { name: 'Suggest & vote' }));
  expect(send).toHaveBeenCalledWith({ type: 'suggest-video', pollId: 'poll', title: movie.title, movie });
});

it('opens reply and reactions with a mobile tap and preserves drafts and focus', async () => {
  vi.spyOn(window, 'matchMedia').mockReturnValueOnce({ matches: true }).mockReturnValueOnce({ matches: true });
  const state = roomReducer(hostState(), { message: { type: 'chat', commentId: 'one', clientId: 'sam', name: 'Sam', message: 'Movie night?', time: '12:00' } });
  const send = vi.fn(() => true), user = userEvent.setup();
  render(wrap(state, <Chat overlayTarget={document.body} layoutKey="normal" />, send));
  await user.type(screen.getByLabelText('Message'), 'My draft');
  const trigger = screen.getByRole('article');
  expect(screen.queryByRole('button', { name: /^(React|Reply):/ })).not.toBeInTheDocument();
  await user.click(trigger);
  expect(screen.getByRole('menu', { name: 'Message actions' })).toBeVisible();
  expect(screen.getByRole('group', { name: 'Quick reactions' })).toBeVisible();
  await user.keyboard('{Escape}');
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  await user.click(screen.getByRole('menuitem', { name: /Reply/ }));
  expect(screen.getByText('Reply to Sam')).toBeVisible();
  expect(screen.getByLabelText('Message')).toHaveValue('My draft');
  expect(send).not.toHaveBeenCalled();
});

it('keeps desktop text clicks passive and opens actions with Enter', async () => {
  const state = roomReducer(hostState(), { message: { type: 'chat', commentId: 'one', name: 'Sam', message: 'Hello' } });
  const user = userEvent.setup();
  render(wrap(state, <Chat overlayTarget={document.body} layoutKey="normal" />));
  const bubble = screen.getByRole('article');
  await user.click(bubble);
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  bubble.focus(); await user.keyboard('{Enter}');
  expect(screen.getByRole('menu', { name: 'Message actions' })).toBeVisible();
});

it('groups consecutive messages by sender identity and resets names after system messages', () => {
  let state = hostState();
  for (const [commentId, clientId, name] of [['one', 'sam', 'Sam'], ['two', 'sam', 'Sam'], ['three', 'other', 'Sam'], ['four', 'other', 'New name']]) {
    state = roomReducer(state, { message: { type: 'chat', commentId, clientId, name, message: commentId } });
  }
  state = { ...state, messages: [...state.messages, { id: 'notice', system: true, message: 'Joined' }, { ...state.messages.at(-1), id: 'five', commentId: 'five', message: 'five' }] };
  render(wrap(state, <Chat overlayTarget={document.body} layoutKey="normal" />));
  const bubbles = screen.getAllByRole('article');
  expect(bubbles[0].querySelector('.name')).toHaveTextContent('Sam');
  expect(bubbles[1].querySelector('.name')).toBeNull();
  expect(bubbles[2].querySelector('.name')).toHaveTextContent('Sam');
  expect(bubbles[3].querySelector('.name')).toHaveTextContent('New name');
  expect(bubbles[4].querySelector('.name')).toHaveTextContent('New name');
});

it('hides message actions when both replies and reactions are disallowed', () => {
  const state = roomReducer({ ...hostState(), role: 'viewer', permissions: { ...DEFAULT_PERMISSIONS, reactMessages: false, replyChat: false } }, { message: { type: 'chat', commentId: 'one', name: 'Sam', message: 'Hello' } });
  render(wrap(state, <Chat overlayTarget={document.body} layoutKey="normal" />));
  expect(screen.queryByRole('button', { name: /^(Reply|React)/ })).not.toBeInTheDocument();
});

it('starts a poll from a named control and prevents duplicate requests while waiting', async () => {
  const state = hostState(), send = vi.fn(() => true), start = vi.fn();
  const view = render(wrap(state, <PollLauncher onStart={start} />, send));
  await userEvent.click(screen.getByRole('button', { name: 'Start poll' }));
  await userEvent.click(screen.getByRole('button', { name: 'Starting…' }));
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'start-video-poll' });
  expect(start).toHaveBeenCalledOnce();
  view.rerender(wrap({ ...state, event: 1, lastMessage: { type: 'error', action: 'start-video-poll', message: 'Try again later.' } }, <PollLauncher onStart={start} />, send));
  expect(screen.getByRole('alert')).toHaveTextContent('Try again later.');
  expect(screen.getByRole('button', { name: 'Start poll' })).toBeEnabled();
  view.rerender(wrap({ ...state, role: 'viewer', permissions: DEFAULT_PERMISSIONS }, <PollLauncher onStart={start} />, send));
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

it('makes voting the visible poll action and separates finishing from voting', async () => {
  function Example() { const [expanded, setExpanded] = useState(false); return <Poll expanded={expanded} onToggle={() => setExpanded(value => !value)} />; }
  render(wrap({ ...hostState(), poll: { id: 'poll', status: 'open' } }, <Example />));
  expect(screen.queryByRole('button', { name: 'Finish poll' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Vote on next movie' }));
  expect(screen.getByRole('button', { name: 'Hide poll' })).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('heading', { name: 'Add the first movie' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Finish poll' }).closest('.poll-finish')).not.toBeNull();
});

it('confirms finishing with safe focus, then shows tied winners and offers another poll', async () => {
  const user = userEvent.setup(), send = vi.fn(() => true);
  let state = { ...hostState(), poll: { id: 'poll', status: 'open' }, suggestions: [
    { id: 1, title: 'Arrival', votes: 1, ownerName: 'Alex', canRemove: true },
    { id: 2, title: 'Dune', votes: 1, ownerName: 'Sam' },
  ] };
  const view = render(wrap(state, <Poll expanded disclosure={false} />, send));
  expect(screen.queryByRole('textbox', { name: 'Movie title' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Suggest a movie' }));
  expect(screen.getByRole('textbox', { name: 'Movie title' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Close suggestions' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Suggest a movie' })).toHaveFocus());
  const finish = screen.getByRole('button', { name: 'Finish poll' });
  await user.click(finish);
  const dialog = screen.getByRole('dialog', { name: 'Finish this poll?' });
  expect(within(dialog).getByRole('button', { name: 'Keep voting' })).toHaveFocus();
  expect(send).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole('button', { name: 'Keep voting' }));
  await waitFor(() => expect(finish).toHaveFocus());
  await user.click(finish);
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Finish poll' }));
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'finish-video-poll', pollId: 'poll' });
  state = { ...state, poll: { id: 'poll', status: 'closed', result: { suggestions: state.suggestions, winnerIds: [1, 2], totalVotes: 2 } } };
  view.rerender(wrap(state, <Poll expanded disclosure={false} />, send));
  expect(screen.getByRole('heading', { name: 'The votes are in' })).toBeVisible();
  expect(screen.getAllByText('Tied winner')).toHaveLength(2);
  expect(screen.getByRole('heading', { name: 'Arrival' })).toBeVisible();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start another poll' })).toHaveFocus());
});

it('keeps poll viewing available when voting and suggesting are restricted', async () => {
  const state = { ...hostState(), role: 'viewer', permissions: { ...DEFAULT_PERMISSIONS, vote: false, suggestTitles: false }, poll: { id: 'poll', status: 'open' }, suggestions: [{ id: 1, title: 'Arrival', votes: 2, movie: { description: '', pageUrl: 'https://www.themoviedb.org/movie/329865' } }] };
  render(wrap(state, <Poll expanded disclosure={false} />));
  expect(screen.getByRole('heading', { name: 'Arrival' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Vote for Arrival' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Suggest a movie' })).not.toBeInTheDocument();
  expect(screen.getByText('Movie vote:').parentElement).toHaveTextContent('Movie vote: 2 votes');
  expect(screen.getByText('Voting is disabled for you. You can still view the results.')).toBeVisible();
  await userEvent.click(screen.getByText('Movie details'));
  expect(screen.getByRole('link', { name: 'View on TMDB' })).toHaveAttribute('href', 'https://www.themoviedb.org/movie/329865');
});

it('moves focus to suggesting another movie after the first suggestion is confirmed', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ movies: [] }) });
  const user = userEvent.setup(), send = vi.fn(() => true);
  const state = { ...hostState(), poll: { id: 'poll', status: 'open' } };
  const view = render(wrap(state, <Poll expanded disclosure={false} />, send));
  await user.type(screen.getByRole('textbox', { name: 'Movie title' }), 'Dune');
  await user.click(screen.getByRole('button', { name: 'Search' }));
  await user.click(await screen.findByRole('button', { name: 'Suggest “Dune” without a poster' }));
  view.rerender(wrap({ ...state, suggestions: [{ id: 1, title: 'Dune', votes: 1, ownerName: 'Alex' }], myVoteId: 1 }, <Poll expanded disclosure={false} />, send));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Suggest a movie' })).toHaveFocus());
  expect(screen.getByText('Suggested “Dune”.')).toBeVisible();
});

it.each([['Transfer host', 'transfer-host'], ['Kick and block', 'block-participant']])('requires confirmation for %s, with safe Cancel focus and no request on cancellation', async (label, type) => {
  const state = { ...hostState(), sourceOwnerId: 'sam' }, send = vi.fn(() => true), user = userEvent.setup();
  render(wrap(state, <Participants />, send));
  const trigger = personButton();
  await user.click(trigger); await user.click(screen.getByRole('button', { name: label }));
  expect(send).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: `${label}${type === 'transfer-host' ? ' to' : ''} Sam?` })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  if (type === 'block-participant') expect(screen.getByText(/Blocking them stops playback for everyone/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(send).not.toHaveBeenCalled(); expect(trigger).toHaveFocus();
});

it('keeps failed moderation reviewable, blocks repeated sends, and closes only after its own success', async () => {
  let state = hostState(); const send = vi.fn(() => true), user = userEvent.setup();
  const view = render(wrap(state, <Participants />, send));
  await user.click(personButton()); await user.click(screen.getByRole('button', { name: 'Transfer host' }));
  await user.click(screen.getByRole('button', { name: 'Transfer host' }));
  const request = send.mock.calls[0][0];
  await user.click(screen.getByRole('button', { name: 'Updating…' }));
  expect(send).toHaveBeenCalledOnce();
  state = roomReducer(state, { message: { type: 'error', requestId: request.requestId, message: 'Host changed. Try again.' } });
  view.rerender(wrap(state, <Participants />, send));
  expect(screen.getByRole('alert')).toHaveTextContent('Host changed. Try again.');
  expect(screen.getByRole('button', { name: 'Transfer host' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'Transfer host' }));
  const retry = send.mock.calls[1][0];
  state = roomReducer(state, { message: { type: 'participant-action-complete', requestId: 'unrelated' } });
  view.rerender(wrap(state, <Participants />, send));
  expect(screen.getByRole('dialog')).toBeVisible();
  state = roomReducer(state, { message: { type: 'participant-action-complete', requestId: retry.requestId } });
  view.rerender(wrap(state, <Participants />, send));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('rechecks moderation privileges while a confirmation is open', async () => {
  const state = hostState(), send = vi.fn(() => true);
  const view = render(wrap(state, <Participants />, send));
  await userEvent.click(personButton()); await userEvent.click(screen.getByRole('button', { name: 'Kick and block' }));
  view.rerender(wrap({ ...state, role: 'viewer', permissions: DEFAULT_PERMISSIONS }, <Participants />, send));
  expect(screen.getByRole('button', { name: 'Kick and block' })).toBeDisabled();
  expect(screen.getByText(/action is no longer available/)).toBeVisible();
  expect(send).not.toHaveBeenCalled();
});

it('shows individual scope and inheritance, follows live defaults, and waits for permission acknowledgments', async () => {
  let state = { ...hostState(), people: [{ ...viewer, permissionOverrides: { seek: true }, permissions: { ...DEFAULT_PERMISSIONS, seek: true } }] };
  const send = vi.fn(() => true), user = userEvent.setup();
  const view = render(wrap(state, <Participants />, send));
  await user.click(personButton());
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Edit permissions' }));
  const dialog = screen.getByRole('dialog', { name: 'Permissions for Sam' });
  expect(within(dialog).getByRole('group', { name: 'Playback' })).toBeVisible();
  expect(screen.getByLabelText('Seek for Sam')).toBeChecked();
  expect(screen.getByLabelText('Seek for Sam')).toHaveAccessibleDescription('Custom: On. Room default: Off');
  state = { ...state, roomPermissions: { ...DEFAULT_PERMISSIONS, playPause: false } };
  view.rerender(wrap(state, <Participants />, send));
  expect(screen.getByLabelText('Play/pause for Sam')).not.toBeChecked();
  expect(screen.getByLabelText('Play/pause for Sam')).toHaveAccessibleDescription('Room default: Off');
  await user.click(screen.getByRole('button', { name: 'Reset to room default for Seek' }));
  const request = send.mock.calls[0][0];
  expect(request).toMatchObject({ type: 'set-viewer-permissions', clientId: 'sam', permissions: { seek: null } });
  expect(screen.getByLabelText('Seek for Sam')).toBeChecked();
  expect(screen.getByLabelText('Seek for Sam')).toBeDisabled();
  state = roomReducer(state, { message: { type: 'permissions-updated', requestId: request.requestId, clientId: 'sam', permissionOverrides: {}, permissions: state.roomPermissions } });
  view.rerender(wrap(state, <Participants />, send));
  expect(screen.getByLabelText('Seek for Sam')).not.toBeChecked();
  expect(screen.getByLabelText('Seek for Sam')).toHaveAccessibleDescription('Room default: Off');
  expect(screen.getByLabelText('Seek for Sam')).toHaveFocus();
  expect(screen.getByRole('status')).toHaveTextContent('Updated.');
});

it('makes individual permissions read-only for viewers', async () => {
  render(wrap({ ...hostState(), role: 'viewer' }, <Participants />));
  await userEvent.click(personButton()); await userEvent.click(screen.getByRole('button', { name: 'View permissions' }));
  expect(screen.getByText(/These settings are read-only/)).toBeVisible();
  expect(screen.getAllByRole('checkbox').every(checkbox => checkbox.disabled)).toBe(true);
  expect(screen.queryByRole('button', { name: 'Reset all to room defaults' })).not.toBeInTheDocument();
});

it('keeps rejected permission changes uncommitted and restores editing after the error', async () => {
  let state = hostState(); const send = vi.fn(() => true);
  const view = render(wrap(state, <Participants />, send));
  await userEvent.click(personButton()); await userEvent.click(screen.getByRole('button', { name: 'Edit permissions' }));
  await userEvent.click(screen.getByLabelText('Seek for Sam'));
  expect(screen.getByLabelText('Seek for Sam')).not.toBeChecked();
  state = roomReducer(state, { message: { type: 'error', requestId: send.mock.calls[0][0].requestId, message: 'Could not save. Try again.' } });
  view.rerender(wrap(state, <Participants />, send));
  expect(screen.getByRole('alert')).toHaveTextContent('Could not save. Try again.');
  expect(screen.getByLabelText('Seek for Sam')).toBeEnabled();
  expect(screen.getByLabelText('Seek for Sam')).not.toBeChecked();
});

it('labels blocked participants’ permission snapshots without implying current access', async () => {
  const state = { ...hostState(), people: [{ ...viewer, blocked: true, permissions: { ...DEFAULT_PERMISSIONS, seek: true } }] };
  render(wrap(state, <Participants />));
  await userEvent.click(screen.getByRole('button', { name: /Sam.*Blocked/ }));
  expect(screen.getByText('Blocked. No room access.')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'View last permissions' }));
  expect(screen.getByText(/last permissions before blocking/)).toBeVisible();
  expect(screen.getByLabelText('Seek for Sam')).toBeChecked();
  expect(screen.getByLabelText('Seek for Sam')).toBeDisabled();
});
