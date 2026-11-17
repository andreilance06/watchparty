import { describe, it, expect, vi } from 'vitest';
import { fireEvent, within } from '@testing-library/dom';
import { createLiveQualityMenu } from '../js/player/live-quality-menu.js';
import { removeEmptySettingsSections } from '../js/player/settings-sections.js';

const quality = () => ({ resolution: '1080', frameRate: 30, resolutions: ['source', '720', '1080'], frameRates: [15, 30, 60], supported: true, actual: { width: 1920, height: 1080, frameRate: 30 }, pending: false, error: '' });
function setup() {
  const video = document.createElement('movi-player'); video.attachShadow({ mode: 'open' });
  document.body.append(video);
  video.shadowRoot.innerHTML = '<div class="movi-settings-menu"><div class="movi-settings-root"></div><div class="movi-settings-page"><h3 class="movi-settings-page-title"></h3><div class="movi-settings-page-body"></div></div></div>';
  const settings = video.shadowRoot.querySelector('.movi-settings-root');
  video.buildSettingsRoot = () => { settings.innerHTML = '<div class="movi-settings-section-label">Playback</div><button class="movi-settings-row" data-page="aspect">Aspect</button><div class="movi-settings-section-label">Enhancements</div>'; removeEmptySettingsSections(settings); };
  const open = video.openSettingsPage = vi.fn(), close = video.closeSettingsPage = vi.fn();
  video.settingsRowValue = () => '';
  video.clampSettingsPanel = vi.fn();
  const onChange = vi.fn(); let active = true;
  const menu = createLiveQualityMenu({ video, isActive: () => active, onChange });
  menu.update(quality()); video.buildSettingsRoot();
  return { video, menu, onChange, open, close, settings, ui: within(video.shadowRoot), deactivate() { active = false; } };
}

describe('live player quality settings', () => {
  it('opens in native Settings, stages resolution/fps together, and reports pending and actual capture quality', () => {
    const h = setup();
    expect(h.ui.getByRole('button', { name: /Screen sharing/ })).toBeInTheDocument();
    h.video.openSettingsPage('screen-share');
    expect(h.open).not.toHaveBeenCalled();
    const resolution = h.ui.getByRole('combobox', { name: 'Resolution' }), fps = h.ui.getByRole('combobox', { name: 'Frame rate' });
    expect(h.ui.getByRole('button', { name: 'Apply' })).toBeDisabled();
    fireEvent.change(resolution, { target: { value: '720' } }); fireEvent.change(fps, { target: { value: '60' } });
    fireEvent.click(h.ui.getByRole('button', { name: 'Apply' }));
    expect(h.onChange).toHaveBeenCalledWith({ resolution: '720', frameRate: 60 });
    h.menu.update({ ...quality(), pending: true });
    expect(resolution).toBeDisabled(); expect(fps).toBeDisabled();
    expect(h.ui.getByRole('button', { name: 'Applying\u2026' })).toBeDisabled();
    h.menu.update({ ...quality(), resolution: '720', frameRate: 60, actual: { width: 1280, height: 720, frameRate: 60 } });
    expect(h.ui.getByRole('status')).toHaveTextContent('1280 \u00d7 720 at 60 fps');
    expect(resolution).toHaveValue('720'); expect(h.ui.getByRole('button', { name: 'Apply' })).toBeDisabled();
    h.video.closeSettingsPage(); expect(h.video._settingsPage).toBeNull();
    h.video.openSettingsPage('aspect'); expect(h.open).toHaveBeenCalledWith('aspect');
    h.menu.destroy(); expect(h.video.openSettingsPage).toBe(h.open); expect(h.video.closeSettingsPage).toBe(h.close); h.video.remove();
  });

  it('keeps rejected drafts editable, explains unsupported browsers, and removes provider controls on source replacement', () => {
    const h = setup(); h.video.openSettingsPage('screen-share');
    const resolution = h.ui.getByRole('combobox', { name: 'Resolution' });
    fireEvent.change(resolution, { target: { value: '720' } });
    h.menu.update({ ...quality(), error: 'Try a lower frame rate.' });
    expect(h.ui.getByRole('alert')).toHaveTextContent('Try a lower frame rate.'); expect(resolution).toHaveValue('720');
    h.menu.update({ ...quality(), supported: false });
    expect(resolution).toBeDisabled(); expect(h.ui.getByRole('status')).toHaveTextContent('cannot change capture quality');
    h.deactivate(); h.menu.update(null);
    expect(h.video._settingsPage).toBeNull(); expect(h.ui.queryByRole('button', { name: /Screen sharing/ })).toBeNull();
    h.menu.destroy(); h.video.remove();
  });

  it('removes empty section headings while retaining sections that have settings', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div class="movi-settings-section-label">Playback</div><button>Aspect</button><div class="movi-settings-section-label">Enhancements</div><div class="movi-settings-section-label">Other</div>';
    removeEmptySettingsSections(root);
    expect(root.textContent).toBe('PlaybackAspect');
  });
});
