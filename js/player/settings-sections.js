export function removeEmptySettingsSections(root) {
  for (const label of root?.querySelectorAll('.movi-settings-section-label') || []) {
    const next = label.nextElementSibling;
    if (!next || next.classList.contains('movi-settings-section-label')) label.remove();
  }
}
