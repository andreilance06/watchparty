import React, { useRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { Button, Dialog, Field, Status } from './shared.jsx';

it('prevents repeat submissions while a shared button is pending and resumes afterward', async () => {
  const submit = vi.fn(event => event.preventDefault());
  const view = render(<form onSubmit={submit}><Button type="submit" pending pendingLabel="Creating…">Create room</Button></form>);
  const user = userEvent.setup();
  expect(screen.getByRole('button', { name: 'Creating…' })).toHaveAttribute('aria-busy', 'true');
  await user.click(screen.getByRole('button'));
  expect(submit).not.toHaveBeenCalled();
  view.rerender(<form onSubmit={submit}><Button type="submit">Create room</Button><Button>Cancel</Button></form>);
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(submit).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Create room' }));
  expect(submit).toHaveBeenCalledOnce();
});

it('connects field help and errors without losing caller descriptions or duplicating ids', () => {
  render(<><p id="scope">Room defaults</p><Field label="Name" hint="Use a display name." error="This name is in use." aria-describedby="scope" /><Field label="Other name" /></>);
  const name = screen.getByLabelText('Name');
  expect(name).toHaveAccessibleDescription('Room defaults Use a display name. This name is in use.');
  expect(name).toHaveAttribute('aria-invalid', 'true');
  expect(name.id).not.toBe(screen.getByLabelText('Other name').id);
});

it('announces routine feedback politely and errors as alerts', () => {
  const view = render(<Status>Connecting…</Status>);
  expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  view.rerender(<Status tone="error">Could not connect. Try again.</Status>);
  expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive');
});

it('keeps a busy dialog open on Escape and allows cancellation after the operation', () => {
  const close = vi.fn();
  const view = render(<Dialog title="Create a room" onClose={close} busy><Field label="Name" /></Dialog>);
  const dialog = screen.getByRole('dialog', { name: 'Create a room' });
  expect(dialog.open).toBe(true);
  fireEvent(dialog, new Event('cancel', { cancelable: true }));
  expect(close).not.toHaveBeenCalled();
  view.rerender(<Dialog title="Create a room" onClose={close}><Field label="Name" /></Dialog>);
  fireEvent(dialog, new Event('cancel', { cancelable: true }));
  expect(close).toHaveBeenCalledOnce();
});

it('keeps a modal Escape from also dismissing the disclosure that opened it', () => {
  const outsideKey = vi.fn();
  render(<div onKeyDown={outsideKey}><Dialog title="Permissions" onClose={() => {}}><Button>Close</Button></Dialog></div>);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(outsideKey).not.toHaveBeenCalled();
});

it('returns focus to the opener after a dialog unmounts', async () => {
  function Example() {
    const opener = useRef(null);
    const [open, setOpen] = useState(false);
    return <><Button ref={opener} onClick={() => setOpen(true)}>Permissions</Button>{open && <Dialog title="Permissions" returnFocusRef={opener} onClose={() => setOpen(false)}><Button onClick={() => setOpen(false)}>Close</Button></Dialog>}</>;
  }
  render(<Example />);
  await userEvent.click(screen.getByRole('button', { name: 'Permissions' }));
  await userEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.getByRole('button', { name: 'Permissions' })).toHaveFocus();
});
