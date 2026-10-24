// Isolate the same pinned Movi Settings hooks used by native-caption-menu.
// The vendor bundle and decoder APIs remain untouched.
export function createNativeQualityMenu({ video, onChange }) {
  let state = {}, qualitySelect, bitrateSelect, status, container;
  function render() {
    const list = video.shadowRoot?.querySelector(".movi-quality-list");
    if (!list || !state.enabled) return;
    if (!container || container.parentNode !== list) {
      container = document.createElement("div"); container.dataset.watchpartyQuality = "";
      container.style.cssText = "padding:8px 12px;display:grid;gap:12px;min-width:220px;max-width:100%;box-sizing:border-box";
      const field = (name, handler) => {
        const label = document.createElement("label"); label.style.cssText = "display:grid;gap:6px;font:inherit";
        const title = document.createElement("span"); title.textContent = name;
        const select = document.createElement("select"); select.setAttribute("aria-label", name);
        select.style.cssText = "font:inherit;color:inherit;background:var(--movi-menu-bg,#222);border:1px solid currentColor;border-radius:6px;padding:8px;width:100%;color-scheme:dark";
        select.addEventListener("change", event => { event.stopPropagation(); handler(select.value); });
        label.appendChild(title); label.appendChild(select); container.appendChild(label); return select;
      };
      qualitySelect = field("Quality", value => onChange({ quality: value, bitrate: value === "source" ? "auto" : state.bitrate }));
      bitrateSelect = field("Bitrate limit", value => onChange({ quality: state.quality, bitrate: value === "auto" ? "auto" : Number(value) }));
      status = document.createElement("p"); status.setAttribute("role", "status");
      status.style.cssText = "font:inherit;font-size:12px;white-space:normal;line-height:1.5;margin:0;opacity:.85";
      container.appendChild(status);
      const auto = document.createElement("button"); auto.type = "button"; auto.className = "movi-settings-choice";
      auto.textContent = "Return to Auto"; auto.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); onChange({ quality: "auto", bitrate: "auto" }); });
      container.appendChild(auto); list.replaceChildren(container);
    }
    const fill = (select, values, selected) => {
      const key = JSON.stringify(values);
      if (select.dataset.choices !== key) {
        select.replaceChildren();
        for (const [value, text, disabled] of values) {
          const option = document.createElement("option"); option.value = String(value); option.textContent = text;
          option.disabled = Boolean(disabled); select.appendChild(option);
        }
        select.dataset.choices = key;
      }
      select.value = String(selected);
    };
    fill(qualitySelect, [["auto", "Auto"], ["source", "Source / Original", !state.sourceSupported],
      ...(state.options || []).map(option => [option.quality, `${option.quality}p`])], state.quality);
    fill(bitrateSelect, [["auto", "Auto"], ...(state.bitrateLimits || []).map(rate => [rate, `${rate / 1000000} Mbps`])], state.bitrate);
    bitrateSelect.disabled = state.quality === "source";
    if (status.textContent !== (state.status || "")) status.textContent = state.status || "";
  }
  function hook(name, replacement) {
    const original = video[name]?.bind(video);
    video[name] = (...args) => replacement(original, ...args);
  }
  hook("updateQualityMenu", original => state.enabled ? render() : original?.());
  hook("settingsRowAvailable", (original, selector, items) => selector === ".movi-quality-container" && state.enabled ? true : original?.(selector, items));
  hook("settingsRowValue", (original, page) => page === "quality" && state.enabled ? state.label || "Auto" : original?.(page));
  hook("clampSettingsPanel", (original, panel) => {
    original?.(panel);
    // Movi measures the timeline to place Settings above the controls. Viewers
    // without seek permission have a hidden timeline (a zero-sized rectangle).
    // Its viewport origin must not become a several-hundred-pixel bottom inset.
    const row = panel?.closest?.(".movi-buttons-row");
    const progress = panel?.closest?.(".movi-controls-bar")?.querySelector(".movi-progress-container");
    if (state.enabled && row && progress && !progress.getBoundingClientRect().height &&
        typeof getComputedStyle === "function" && getComputedStyle(panel).position !== "fixed") {
      panel.style.bottom = `${Math.round(row.getBoundingClientRect().height + 6)}px`;
    }
  });
  hook("hideControls", original => {
    if (state.enabled && video._settingsPage === "quality" && video.shadowRoot?.querySelector(".movi-settings-menu.is-open")) video.showControls?.();
    else original?.();
  });
  return { update(next) { state = next; render(); } };
}
