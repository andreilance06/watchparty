import { Fragment, useEffect, useRef, useState } from 'react';
import { can, DEFAULT_PERMISSIONS, PERMISSION_CATALOG } from '../js/permissions.js';
import { Dialog, ParticipantPopover, Status } from './shared.jsx';
import { useCommand, useRoom } from './room.jsx';

export function PermissionFields({ values, disabled, onChange, person, overrides }) {
  let group;
  return PERMISSION_CATALOG.map(item => {
    const heading = group !== item.group; group = item.group;
    return <Fragment key={item.key}>{heading && <h3 className="permission-group">{group}</h3>}
      <label className="permission-switch flex items-center justify-between gap-2"><span>{item.label}</span><input type="checkbox" checked={Boolean(values[item.key])} disabled={disabled} aria-label={`${item.label} ${person ? `for ${person}` : 'by default'}`} onChange={event => onChange({ [item.key]: event.target.checked })} /></label>
      {overrides && <button className="permission-inherit" disabled={disabled || !Object.hasOwn(overrides, item.key)} aria-label={`Use room default for ${item.label}`} onClick={() => onChange({ [item.key]: null })}>{Object.hasOwn(overrides, item.key) ? 'Use room default' : 'Room default'}</button>}
    </Fragment>;
  });
}
export function RoomPermissions({ onClose }) {
  const { state } = useRoom();
  const { execute, pending, status } = useCommand();
  useEffect(() => { if (state.role !== 'host') onClose(); }, [state.role, onClose]);
  return <Dialog title="Viewer permissions" className="permissions-dialog" onClose={onClose}>
    <div className="permissions-dialog-heading"><div><p className="eyebrow">ROOM SETTINGS</p><h2>Viewer permissions</h2></div><button onClick={onClose}>Close</button></div>
    <p>Defaults apply to everyone without an individual override. Select a participant to customize their permissions.</p>
    <PermissionFields values={state.roomPermissions} disabled={!state.connected || state.role !== 'host' || Boolean(pending)} onChange={permissions => execute({ type: 'set-room-permissions', permissions })} />
    <Status>{status}</Status>
  </Dialog>;
}
export function Participants({ hidden = false, tabbed = false }) {
  const { state } = useRoom();
  const [selected, setSelected] = useState(null);
  useEffect(() => { if (hidden) setSelected(null); }, [hidden]);
  const trigger = useRef(null);
  const person = state.people.find(person => person.clientId === selected);
  return <section id="socialPeople" className="participant-section" hidden={hidden} role={tabbed ? 'tabpanel' : undefined} aria-labelledby={tabbed ? 'peopleTab' : 'participants-title'}>
    <h3 id="participants-title">Participants</h3>
    <ul className="participant-list" aria-live="polite">{state.people.map(person => <li className="participant-item" key={person.clientId}>
      <button className={`participant${person.blocked ? ' participant-blocked' : ''}`} aria-haspopup="dialog" aria-expanded={selected === person.clientId} onClick={event => { trigger.current = event.currentTarget; setSelected(person.clientId); }}>
        <span className={`participant-status ${person.blocked ? 'offline' : 'online'}`} aria-label={person.blocked ? 'Blocked' : 'Connected'} /><span className="participant-name">{person.name}</span><span className="participant-role">{person.blocked ? 'Blocked' : person.role === 'host' ? 'Host' : 'Viewer'}</span>
      </button>
    </li>)}</ul>
    {person && !hidden && <ParticipantDetails key={person.clientId} person={person} trigger={trigger.current} onClose={() => { setSelected(null); trigger.current?.focus(); }} />}
  </section>;
}
function ParticipantDetails({ person, trigger, onClose }) {
  const { state } = useRoom();
  const { execute, pending, status } = useCommand();
  const editable = state.connected && state.role === 'host' && person.role !== 'host' && !person.blocked;
  const suppliesVideo = !person.blocked && (person.suppliesVideo || person.clientId === state.sourceOwnerId);
  const ownBrowser = person.clientId === state.clientId || person.sameBrowser;
  const protectedModerator = state.role !== 'host' && (person.permissions?.blockViewers || person.permissions?.unblockViewers);
  const mayBlock = can(state, 'blockViewers') && !person.isCreator && !person.hostBrowser && !ownBrowser && !protectedModerator;
  const action = (label, type, danger = false) => <button disabled={!state.connected || Boolean(pending)} className={danger ? 'participant-danger' : ''} onClick={() => execute({ type, clientId: person.clientId })}>{label}</button>;
  return <ParticipantPopover title={person.name} trigger={trigger} onClose={onClose}>
    <div className="permissions-dialog-heading"><h2>{person.name}</h2><button onClick={onClose}>Close</button></div>
    <p className="participant-detail-role">{person.blocked ? 'Blocked' : person.role === 'host' ? 'Host' : 'Viewer'}</p>
    {suppliesVideo && <p className="participant-provider">Sharing the current video. This browser must stay connected.</p>}
    <PermissionFields values={{ ...DEFAULT_PERMISSIONS, ...person.permissions }} person={person.name} disabled={!editable || Boolean(pending)} overrides={editable ? person.permissionOverrides || {} : null} onChange={permissions => execute({ type: 'set-viewer-permissions', clientId: person.clientId, permissions })} />
    {person.role !== 'host' && <div className="participant-actions">
      {editable && action('Reset all overrides', 'reset-viewer-permissions')}
      {person.blocked ? can(state, 'unblockViewers') && action('Unblock', 'unblock-participant') : <>
        {state.role === 'host' && action('Transfer host', 'transfer-host')}
        {mayBlock && action('Kick and block', 'block-participant', true)}
        {mayBlock && suppliesVideo && <p className="participant-action-warning">Blocking this viewer stops the current video.</p>}
      </>}
    </div>}
    <Status>{status}</Status>
  </ParticipantPopover>;
}
