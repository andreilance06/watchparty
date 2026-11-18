import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { createPlayer } from '../js/player/controller.js';
import { createScreenShare } from '../js/screen-share.js';
import { Player } from './Player.jsx';
import { initialRoom, RoomContext } from './room.jsx';
import { ThemeProvider } from './shared.jsx';

vi.mock('../js/player/controller.js', () => ({ createPlayer: vi.fn() }));
vi.mock('../js/screen-share.js', () => ({ createScreenShare: vi.fn() }));

function renderPlayer(state) {
  const controller = { setChatVisible: vi.fn(), setScreenStream: vi.fn(), destroy: vi.fn() };
  vi.mocked(createPlayer).mockImplementation(({ elements }) => {
    elements.hostControls.hidden = false;
    return controller;
  });
  vi.mocked(createScreenShare).mockReturnValue({ destroy: vi.fn() });
  const context = { state, session: { current: state }, player: { current: { controller } },
    send: vi.fn(() => true), system: vi.fn(), registerPlayer: vi.fn(), attention: { current: null } };
  const portals = { chat: document.createElement('div') };
  const tree = current => <ThemeProvider><RoomContext.Provider value={{ ...context, state: current }}>
    <Player portals={portals} attentionView={{}} />
  </RoomContext.Provider></ThemeProvider>;
  const view = render(tree(state));
  return { controller, container: view.container, send: context.send, update: next => view.rerender(tree(next)) };
}

const hostState = () => ({ ...initialRoom({ clientId: 'host', role: 'host' }), connected: true });

it('dims only the local whole-screen preview and resets dimming for the next share', () => {
  const { controller, container } = renderPlayer({ ...hostState(), media: { sourceType: 'screen' } });
  const { onStream, onChange } = vi.mocked(createScreenShare).mock.lastCall[0];
  const shell = container.querySelector('#videoShell');
  const stream = displaySurface => ({ getVideoTracks: () => [{ getSettings: () => ({ displaySurface }) }] });
  const monitor = stream('monitor');

  act(() => onStream(monitor, false));
  expect(screen.getByRole('button', { name: 'Switch to video' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Disable dimming' })).not.toBeInTheDocument();
  for (const surface of ['browser', 'window', undefined]) {
    act(() => onStream(stream(surface), true));
    expect(shell).not.toHaveClass('is-preview-dimmed');
    expect(screen.queryByRole('button', { name: 'Disable dimming' })).not.toBeInTheDocument();
  }

  act(() => {
    onStream(monitor, true);
    onChange({ local: true });
  });
  expect(screen.queryByRole('button', { name: 'Switch to video' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Stop sharing' })).toBeVisible();
  expect(shell).toHaveClass('is-preview-dimmed');
  expect(controller.setScreenStream).toHaveBeenLastCalledWith(monitor, true);
  controller.setScreenStream.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'Disable dimming' }));
  expect(shell).not.toHaveClass('is-preview-dimmed');
  fireEvent.click(screen.getByRole('button', { name: 'Dim preview' }));
  expect(shell).toHaveClass('is-preview-dimmed');
  fireEvent.click(screen.getByRole('button', { name: 'Disable dimming' }));
  expect(controller.setScreenStream).not.toHaveBeenCalled();

  act(() => {
    onStream(null, false);
    onChange({ local: false });
  });
  expect(screen.getByRole('button', { name: 'Switch to video' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Dim preview' })).not.toBeInTheDocument();
  act(() => onStream(stream('monitor'), true));
  expect(shell).toHaveClass('is-preview-dimmed');
});

it('stops the active file and restores the source choices when the room clears it', () => {
  const state = hostState();
  const sharing = { ...state, media: { sourceType: 'file', sourceId: 'file-1', sourceOwnerId: 'host', processing: true } };
  const { send, update } = renderPlayer(sharing);
  expect(screen.queryByRole('button', { name: 'Choose video' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Share screen' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }));
  expect(send).toHaveBeenCalledWith({ type: 'source-stop', sourceId: 'file-1' });

  update({ ...sharing, role: 'viewer' });
  expect(screen.getByRole('button', { name: 'Stop sharing' })).toBeVisible();
  update(state);
  expect(screen.queryByRole('button', { name: 'Stop sharing' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Choose video' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Share screen' })).toBeVisible();
});
