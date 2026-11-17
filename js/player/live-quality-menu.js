const PAGE = 'screen-share';
const resolutionLabel = value => value === 'source' ? 'Source' : `${value}p`;

// Reuse Movi's Settings navigation and theme; capture ownership stays in screen-share.js.
export function createLiveQualityMenu({ video, isActive, onChange = () => {} }) {
  let state = null, draft = null, panel, resolution, frameRate, apply, status, error;
  const hooks = [];
  const root = () => video.shadowRoot;
  const available = () => Boolean(state && isActive());
  function hook(name, replacement) {
    const original = video[name], descriptor = Object.getOwnPropertyDescriptor(video, name);
    const wrapped = (...args) => replacement(original?.bind(video), ...args);
    video[name] = wrapped;
    hooks.push(() => {
      if (video[name] !== wrapped) return;
      if (descriptor) Object.defineProperty(video, name, descriptor); else delete video[name];
    });
  }
  function summary() { return state ? `${resolutionLabel(state.resolution)} / ${state.frameRate} fps` : ''; }
  function row() {
    const settings = root()?.querySelector('.movi-settings-root');
    if (!settings) return;
    let button = settings.querySelector(`[data-page="${PAGE}"]`);
    if (!available()) { button?.remove(); return; }
    if (!button) {
      button = document.createElement('button'); button.type = 'button';
      button.className = 'movi-settings-row'; button.dataset.page = PAGE;
      const icon = document.createElement('span'); icon.innerHTML = video.constructor.SETTINGS_ICONS?.quality || '';
      const label = document.createElement('span'); label.className = 'movi-settings-row-label'; label.textContent = 'Screen sharing';
      const value = document.createElement('span'); value.className = 'movi-settings-row-value';
      const arrow = document.createElement('span'); arrow.className = 'movi-settings-chevron'; arrow.textContent = '\u203a'; arrow.setAttribute('aria-hidden', 'true');
      button.append(icon, label, value, arrow);
      settings.insertBefore(button, settings.querySelector('.movi-settings-row'));
    }
    button.querySelector('.movi-settings-row-value').textContent = state.pending ? 'Applying\u2026' : summary();
  }
  function createPanel() {
    panel = document.createElement('div'); panel.dataset.watchpartyLiveQuality = '';
    panel.style.cssText = 'display:grid;gap:12px;padding:8px 12px;min-width:0;font:inherit';
    const field = (text, name) => {
      const label = document.createElement('label'); label.style.cssText = 'display:grid;gap:6px;font:inherit';
      const title = document.createElement('span'); title.textContent = text;
      const select = document.createElement('select'); select.name = name;
      select.setAttribute('aria-label', text); select.setAttribute('aria-describedby', 'watchparty-live-quality-status watchparty-live-quality-error');
      select.style.cssText = 'font:inherit;color:inherit;background:var(--movi-glass-bg);border:1px solid currentColor;border-radius:6px;padding:8px;min-height:44px;width:100%;max-width:100%';
      select.addEventListener('change', () => { draft = { resolution: resolution.value, frameRate: Number(frameRate.value) }; render(); });
      label.append(title, select); panel.append(label); return select;
    };
    const style = document.createElement('style');
    style.textContent = '[data-watchparty-live-quality] :is(select,button):focus-visible{outline:2px solid var(--movi-primary-color)!important;outline-offset:2px}[data-watchparty-live-quality] :disabled{opacity:.5;cursor:default}[data-watchparty-live-quality] select{color-scheme:dark}:host([theme="light"]) [data-watchparty-live-quality] select{color-scheme:light}';
    panel.append(style);
    resolution = field('Resolution', 'screen-resolution'); frameRate = field('Frame rate', 'screen-frame-rate');
    const help = document.createElement('p'); help.textContent = 'Changes apply to everyone watching. Higher settings use more upload bandwidth.';
    help.style.cssText = 'margin:0;font-size:12px;line-height:1.5;white-space:normal'; panel.append(help);
    status = document.createElement('p'); status.id = 'watchparty-live-quality-status'; status.setAttribute('role', 'status');
    status.style.cssText = help.style.cssText; panel.append(status);
    error = document.createElement('p'); error.id = 'watchparty-live-quality-error'; error.setAttribute('role', 'alert'); error.style.cssText = help.style.cssText; panel.append(error);
    apply = document.createElement('button'); apply.type = 'button'; apply.className = 'movi-settings-choice'; apply.style.cssText = 'min-height:44px;justify-content:center;border:1px solid currentColor;border-radius:6px';
    apply.addEventListener('click', event => { event.stopPropagation(); if (available() && !apply.disabled) onChange({ ...draft }); }); panel.append(apply);
    // Retain native select/button keyboard behavior without triggering player shortcuts.
    for (const type of ['keydown', 'keyup', 'click']) panel.addEventListener(type, event => event.stopPropagation());
  }
  function options(select, values, label) {
    const key = JSON.stringify(values);
    if (select.dataset.choices === key) return;
    select.dataset.choices = key;
    select.replaceChildren(...values.map(value => {
      const option = document.createElement('option'); option.value = String(value); option.textContent = label(value); return option;
    }));
  }
  function render() {
    if (!panel || !state) return;
    options(resolution, state.resolutions, value => value === 'source' ? 'Source (original size)' : `Up to ${value}p`);
    options(frameRate, state.frameRates, value => `Up to ${value} fps`);
    resolution.value = draft?.resolution ?? state.resolution; frameRate.value = String(draft?.frameRate ?? state.frameRate);
    resolution.disabled = frameRate.disabled = state.pending || !state.supported;
    const changed = resolution.value !== state.resolution || Number(frameRate.value) !== state.frameRate;
    apply.disabled = !changed || state.pending || !state.supported;
    apply.textContent = state.pending ? 'Applying\u2026' : 'Apply'; apply.setAttribute('aria-busy', String(state.pending));
    const actual = state.actual || {};
    status.textContent = state.pending ? 'Applying screen-share settings\u2026' : !state.supported ? 'This browser cannot change capture quality during a share.' : actual.width && actual.height
      ? `Capturing ${actual.width} \u00d7 ${actual.height}${actual.frameRate ? ` at ${Math.round(actual.frameRate)} fps` : ''}. Browser and source limits may reduce quality.`
      : 'Browser and source limits may reduce the selected quality.';
    error.textContent = state.error || ''; error.hidden = !state.error;
  }
  function close(animate = false) {
    if (video._settingsPage !== PAGE) return;
    panel?.remove();
    const settings = root()?.querySelector('.movi-settings-root'), page = root()?.querySelector('.movi-settings-page');
    if (page) page.style.display = 'none';
    if (settings) { settings.style.display = 'block'; if (animate) video.animateSettingsView?.(settings, 'back'); }
    video._settingsPage = null; draft = null;
  }
  hook('buildSettingsRoot', (original, ...args) => { const result = original?.(...args); row(); return result; });
  hook('settingsRowValue', (original, page) => page === PAGE ? summary() : original?.(page));
  hook('openSettingsPage', (original, pageName) => {
    if (pageName !== PAGE) { close(); return original?.(pageName); }
    if (!available()) return;
    const settings = root()?.querySelector('.movi-settings-root'), page = root()?.querySelector('.movi-settings-page'), body = root()?.querySelector('.movi-settings-page-body'), title = root()?.querySelector('.movi-settings-page-title');
    if (!settings || !page || !body) return;
    video.closeSettingsPage?.(false);
    if (!panel) createPanel();
    draft = { resolution: state.resolution, frameRate: state.frameRate }; render();
    body.replaceChildren(panel); settings.style.display = 'none'; page.style.display = 'block';
    if (title) title.textContent = 'Screen sharing';
    video._settingsPage = PAGE; video.animateSettingsView?.(page, 'forward');
    video.clampSettingsPanel?.(root()?.querySelector('.movi-settings-menu'));
  });
  hook('closeSettingsPage', (original, animate = true) => video._settingsPage === PAGE ? close(animate) : original?.(animate));
  return { update(value) {
    const applied = state?.pending && value && !value.pending && !value.error;
    state = value;
    if (!available()) close();
    else { if (applied) draft = null; render(); }
    row();
  }, destroy() {
    close(); state = null; row(); panel?.remove();
    for (const restore of hooks.reverse()) restore();
  } };
}
