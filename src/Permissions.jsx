import { useEffect, useId, useRef, useState } from 'react';
import { can, DEFAULT_PERMISSIONS, PERMISSION_CATALOG } from '../js/permissions.js';
import { Button, Dialog, DialogHeader, ParticipantPopover, Status } from './shared.jsx';
import { useCommand, useRoom } from './room.jsx';

const groups = [...new Set(PERMISSION_CATALOG.map(item => item.group))];
export function PermissionFields({ values, disabled, readOnly = false, onChange, person, overrides, roomDefaults = DEFAULT_PERMISSIONS }) {
  const id = useId();
  const reset = useRef(null);
  useEffect(() => {
    if (reset.current && !disabled && !Object.hasOwn(overrides || {}, reset.current.key)) {
      reset.current.input?.focus(); reset.current = null;
    }
  }, [overrides, disabled]);
  return groups.map(group => <fieldset key={group} className="permission-fieldset"><legend className="permission-group">{group}</legend>
    {PERMISSION_CATALOG.filter(item => item.group === group).map(item => {
      const custom = overrides && Object.hasOwn(overrides, item.key);
      const value = overrides ? custom ? overrides[item.key] : roomDefaults[item.key] : values[item.key];
      const descriptionId = `${id}-${item.key}`;
      return <div className="permission-row" key={item.key}>
        <label className="permission-switch"><span>{item.label}</span><input id={`${descriptionId}-input`} type="checkbox" checked={Boolean(value)} disabled={disabled} aria-describedby={overrides ? descriptionId : undefined} aria-label={`${item.label} ${person ? `for ${person}` : 'by default'}`} onChange={event => onChange({ [item.key]: event.target.checked })} /></label>
        {overrides && <p id={descriptionId} className="permission-origin">{custom ? `Custom: ${value ? 'On' : 'Off'}. ` : ''}Room default: {roomDefaults[item.key] ? 'On' : 'Off'}</p>}
        {custom && !readOnly && <Button variant="quiet" className="permission-inherit" disabled={disabled} aria-label={`Reset to room default for ${item.label}`} onClick={() => { reset.current = { key: item.key, input: document.getElementById(`${descriptionId}-input`) }; onChange({ [item.key]: null }); }}>Reset to room default</Button>}
      </div>;
    })}
  </fieldset>);
}
export function RoomPermissions({ onClose, returnFocusRef }) {
  const { state } = useRoom();
  const { execute, pending, status, result } = useCommand();
  useEffect(() => { if (state.role !== 'host') onClose(); }, [state.role, onClose]);
  return <Dialog title="Viewer permissions" wide className="permissions-dialog" onClose={onClose} returnFocusRef={returnFocusRef}>
    <DialogHeader title="Viewer permissions" eyebrow="ROOM SETTINGS" onClose={onClose} />
    <p>Defaults apply to everyone without an individual override. Select a participant to customize their permissions.</p>
    <PermissionFields values={state.roomPermissions} disabled={!state.connected || state.role !== 'host' || Boolean(pending)} onChange={permissions => execute({ type: 'set-room-permissions', permissions })} />
    <Status tone={result?.type === 'error' ? 'error' : 'neutral'}>{status}</Status>
  </Dialog>;
}
export function Participants({ hidden = false, tabbed = false }) {
  const { state } = useRoom();
  const [selected, setSelected] = useState(null);
  useEffect(() => { if (hidden) setSelected(null); }, [hidden]);
  const trigger = useRef(null);
  const person = state.people.find(person => person.clientId === selected);
  const people = [...state.people].sort((a, b) => Number(b.clientId === state.clientId) - Number(a.clientId === state.clientId));
  return <section id="socialPeople" className="participant-section" hidden={hidden} role={tabbed ? 'tabpanel' : undefined} aria-labelledby={tabbed ? 'peopleTab' : 'participants-title'}>
    <h3 id="participants-title" className="sr-only">People</h3>
    <ul className="participant-list" aria-live="polite">{people.map(person => <li className="participant-item" key={person.clientId}>
      <button className={`participant${person.clientId === state.clientId ? ' participant-self' : ''}${person.blocked ? ' participant-blocked' : ''}`} aria-haspopup="dialog" aria-expanded={selected === person.clientId} onClick={event => { trigger.current = event.currentTarget; setSelected(person.clientId); }}>
        <span className="watch-person-avatar" aria-hidden="true">{[...person.name.trim()][0]?.toUpperCase() || '?'}</span><span className={`participant-status ${person.blocked ? 'offline' : 'online'}`} aria-label={person.blocked ? 'Blocked' : 'Connected'} /><span className="participant-name">{person.name}</span>{person.clientId === state.clientId && <span className="participant-you">You</span>}<span className="participant-role">{person.blocked ? 'Blocked' : person.role === 'host' ? 'Host' : 'Viewer'}</span>
      </button>
    </li>)}</ul>
    {person && !hidden && <ParticipantDetails key={person.clientId} person={person} triggerRef={trigger} onClose={() => { setSelected(null); trigger.current?.focus(); }} />}
  </section>;
}
function ParticipantDetails({ person, triggerRef, onClose }) {
  const { state } = useRoom();
  const { execute, pending, status, result, setStatus } = useCommand();
  const [view, setView] = useState('details');
  const cancel = useRef(null), confirmationRequest = useRef(null);
  const editable = state.connected && state.role === 'host' && person.role !== 'host' && !person.blocked;
  const suppliesVideo = !person.blocked && (person.suppliesVideo || person.clientId === state.sourceOwnerId);
  const ownBrowser = person.clientId === state.clientId || person.sameBrowser;
  const protectedModerator = state.role !== 'host' && (person.permissions?.blockViewers || person.permissions?.unblockViewers);
  const mayBlock = person.role !== 'host' && !person.blocked && can(state, 'blockViewers') && !person.isCreator && !person.hostBrowser && !ownBrowser && !protectedModerator;
  const mayTransfer = state.role === 'host' && person.role !== 'host' && !person.blocked && person.clientId !== state.clientId;
  const confirming = view === 'transfer' || view === 'block';
  const allowed = view === 'transfer' ? mayTransfer : mayBlock;
  const open = next => { setStatus(''); setView(next); };
  useEffect(() => { if (confirming) cancel.current?.focus(); }, [confirming]);
  useEffect(() => {
    if (result?.requestId === confirmationRequest.current && result?.type === 'participant-action-complete') onClose();
  }, [result, onClose]);
  const permissions = person.role === 'host' ? Object.fromEntries(PERMISSION_CATALOG.map(item => [item.key, true])) : { ...DEFAULT_PERMISSIONS, ...state.roomPermissions, ...person.permissions };
  const overrides = person.permissionOverrides || {};
  const feedback = <Status tone={result?.type === 'error' ? 'error' : 'neutral'}>{status}</Status>;
  if (view === 'permissions') return <Dialog title={`Permissions for ${person.name}`} wide className="permissions-dialog" busy={Boolean(pending)} returnFocusRef={triggerRef} onClose={onClose}>
    <DialogHeader title={`Permissions for ${person.name}`} eyebrow="INDIVIDUAL SETTINGS" busy={Boolean(pending)} onClose={onClose} />
    <p className="ui-dialog-description">{person.blocked ? 'These are the last permissions before blocking. This participant has no room access while blocked.' : person.role === 'host' ? 'The host has all room permissions.' : `Room default follows future room updates. Custom applies to ${person.name}’s browser in this room.`}</p>
    <p className="ui-dialog-description">{editable ? 'Changes save immediately across their tabs in this room. Reset a custom setting to follow the room default again.' : 'These settings are read-only. Only the current host can edit a connected viewer’s permissions.'}</p>
    <PermissionFields values={permissions} roomDefaults={state.roomPermissions} person={person.name} disabled={!editable || Boolean(pending)} readOnly={state.role !== 'host' || person.role === 'host' || person.blocked} overrides={person.role === 'host' || person.blocked ? null : overrides} onChange={permissions => execute({ type: 'set-viewer-permissions', clientId: person.clientId, permissions })} />
    {editable && <Button disabled={Boolean(pending) || !Object.keys(overrides).length} onClick={() => execute({ type: 'reset-viewer-permissions', clientId: person.clientId })}>Reset all to room defaults</Button>}
    <div className="permission-feedback">{feedback}</div>
  </Dialog>;
  if (confirming) return <Dialog title={view === 'transfer' ? `Transfer host to ${person.name}?` : `Kick and block ${person.name}?`} busy={Boolean(pending)} returnFocusRef={triggerRef} onClose={onClose}>
    <DialogHeader title={view === 'transfer' ? `Transfer host to ${person.name}?` : `Kick and block ${person.name}?`} />
    <p className="ui-dialog-description">{view === 'transfer' ? `${person.name} will control room settings and playback. You will become a viewer. The browser sharing the video must stay connected.` : `${person.name} will be removed from this room across all tabs in their browser. They cannot rejoin until a host unblocks their browser.`}</p>
    {view === 'block' && suppliesVideo && <p className="moderation-warning">This viewer is sharing the current video. Blocking them stops playback for everyone.</p>}
    {!allowed && <Status tone="warning">Your permissions or this participant’s role changed. This action is no longer available.</Status>}
    {!state.connected && <Status tone="warning">Reconnect before managing participants.</Status>}
    {feedback}
    <div className="confirmation-actions"><Button ref={cancel} disabled={Boolean(pending)} onClick={onClose}>Cancel</Button><Button variant={view === 'block' ? 'danger' : 'primary'} disabled={!state.connected || !allowed} pending={Boolean(pending)} pendingLabel="Updating…" onClick={() => {
      if (!state.connected || !allowed) return;
      confirmationRequest.current = execute({ type: view === 'transfer' ? 'transfer-host' : 'block-participant', clientId: person.clientId });
    }}>{view === 'transfer' ? 'Transfer host' : 'Kick and block'}</Button></div>
  </Dialog>;
  return <ParticipantPopover title={person.name} trigger={triggerRef.current} onClose={onClose}>
    <DialogHeader title={person.name} onClose={onClose} />
    <p className="participant-detail-role">{person.blocked ? 'Blocked' : person.role === 'host' ? 'Host' : 'Viewer'}</p>
    {suppliesVideo && <p className="participant-provider">Sharing the current video. This browser must stay connected.</p>}
    <p className="participant-permission-summary">{person.blocked ? 'Blocked. No room access.' : person.role === 'host' ? 'Full room access as host.' : Object.keys(overrides).length ? `${Object.keys(overrides).length} custom ${Object.keys(overrides).length === 1 ? 'permission' : 'permissions'}. Other settings follow room defaults.` : 'All permissions follow room defaults.'}</p>
    <Button className="participant-permissions-open" aria-haspopup="dialog" onClick={() => open('permissions')}>{person.blocked ? 'View last permissions' : editable ? 'Edit permissions' : 'View permissions'}</Button>
    {person.role !== 'host' && <div className="participant-actions">
      {person.blocked ? can(state, 'unblockViewers') && <Button disabled={!state.connected || Boolean(pending)} onClick={() => execute({ type: 'unblock-participant', clientId: person.clientId })}>Unblock</Button> : <>
        {mayTransfer && <Button disabled={!state.connected} aria-haspopup="dialog" onClick={() => open('transfer')}>Transfer host</Button>}
        {mayBlock && <Button variant="danger" disabled={!state.connected} aria-haspopup="dialog" onClick={() => open('block')}>Kick and block</Button>}
        {mayBlock && suppliesVideo && <p className="participant-action-warning">Blocking this viewer stops the current video.</p>}
      </>}
    </div>}
    {feedback}
  </ParticipantPopover>;
}
