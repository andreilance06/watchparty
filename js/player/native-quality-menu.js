// Isolate the same pinned Movi Settings hooks used by native-caption-menu.
// The vendor bundle and decoder APIs remain untouched.
export function createNativeQualityMenu({ video, onChange }) {
  let state = {}, qualitySelect, bitrateSlider, bitrateAuto, bitrateLabel, auto, status, container;
  let dragging = false, lastManual, previousResolution = "auto";
  const bounds = () => state.bitrateRange || { min: 25000, max: 8000000, step: 1000 };
  const clamp = value => Math.max(bounds().min, Math.min(bounds().max, Math.round(value / bounds().step) * bounds().step));
  const resolution = () => state.quality === "source" ? previousResolution : state.quality;
  const defaultBitrate = () => (state.options || []).find(option => option.quality === resolution())?.bitrate ||
    (state.options || []).find(option => Number(option.quality) <= 720)?.bitrate || bounds().max;
  function describeSlider() {
    const value = Number(bitrateSlider.value);
    const ratio = value / bounds().max;
    const level = ratio < 0.1875 ? "Low" : ratio < 0.375 ? "Medium" : ratio < 0.625 ? "High" : "Very high";
    const text = value > bounds().max ? "Source" : `${level} · ${Number((value / 1000000).toFixed(3))} Mbps`;
    bitrateLabel.textContent = bitrateAuto.checked ? "Auto" : text;
    bitrateSlider.setAttribute("aria-valuetext", bitrateLabel.textContent);
    const progress = (value - bounds().min) / (Number(bitrateSlider.max) - bounds().min) * 100;
    bitrateSlider.style.background = `linear-gradient(to right,var(--movi-primary-color,#8b7bff) ${progress}%,#666 ${progress}%)`;
  }
  function selectBitrate(value) {
    if (value === "source") {
      if (state.quality !== "source") previousResolution = state.quality;
      onChange({ quality: "source", bitrate: "source" });
    } else {
      lastManual = clamp(value);
      onChange({ quality: resolution(), bitrate: lastManual });
    }
  }
  function render() {
    const list = video.shadowRoot?.querySelector(".movi-quality-list");
    if (!list || !state.enabled) return;
    const trigger = video.shadowRoot?.querySelector(".movi-quality-btn");
    trigger?.setAttribute("aria-label", "Resolution");
    trigger?.setAttribute("title", "Resolution");
    if (!container || container.parentNode !== list) {
      container = document.createElement("div"); container.dataset.watchpartyQuality = "";
      container.style.cssText = "padding:8px 12px;display:grid;gap:12px;min-width:220px;max-width:100%;box-sizing:border-box";
      const style = document.createElement("style");
      style.textContent = `
        [data-watchparty-quality] input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:var(--movi-primary-color,#8b7bff);cursor:grab;
        }
        [data-watchparty-quality] input[type="range"]::-moz-range-thumb {
          width:18px;height:18px;border:0;border-radius:50%;background:var(--movi-primary-color,#8b7bff);cursor:grab;
        }
        [data-watchparty-quality] :is(input,select,button):focus-visible {
          outline:2px solid var(--movi-primary-color,#8b7bff)!important;outline-offset:3px;
        }
      `;
      container.appendChild(style);
      const field = (name, handler) => {
        const label = document.createElement("label"); label.style.cssText = "display:grid;gap:6px;font:inherit";
        const title = document.createElement("span"); title.textContent = name;
        const select = document.createElement("select"); select.setAttribute("aria-label", name);
        select.style.cssText = "font:inherit;color:inherit;background:var(--movi-menu-bg,#222);border:1px solid currentColor;border-radius:6px;padding:8px;width:100%;color-scheme:dark";
        select.addEventListener("change", event => { event.stopPropagation(); handler(select.value); });
        label.appendChild(title); label.appendChild(select); container.appendChild(label); return select;
      };
      qualitySelect = field("Resolution", value => {
        if (value === "source") selectBitrate("source");
        else { previousResolution = value; onChange({ quality: value, bitrate: state.bitrate === "source" ? "auto" : state.bitrate }); }
      });
      const bitrateField = document.createElement("div"); bitrateField.style.cssText = "display:grid;gap:10px";
      const heading = document.createElement("div"); heading.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px";
      const title = document.createElement("span"); title.textContent = "Bitrate";
      const toggle = document.createElement("label"); toggle.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer";
      bitrateAuto = document.createElement("input"); bitrateAuto.type = "checkbox"; bitrateAuto.setAttribute("aria-label", "Auto bitrate");
      bitrateAuto.style.cssText = "appearance:auto;position:static;opacity:1;width:16px;height:16px;margin:0;flex-shrink:0;clip:auto;clip-path:none;pointer-events:auto;accent-color:var(--movi-primary-color,#8b7bff)";
      const toggleText = document.createElement("span"); toggleText.textContent = "Auto";
      toggle.append(bitrateAuto, toggleText); heading.append(title, toggle);
      bitrateLabel = document.createElement("output"); bitrateLabel.dataset.bitrateLabel = "";
      bitrateLabel.style.cssText = "font:inherit;font-size:13px";
      bitrateSlider = document.createElement("input"); bitrateSlider.type = "range"; bitrateSlider.setAttribute("aria-label", "Bitrate");
      bitrateSlider.style.cssText = "appearance:none;width:100%;min-width:0;margin:8px 0;cursor:pointer;accent-color:var(--movi-primary-color,#8b7bff);border-radius:999px;height:6px";
      bitrateSlider.addEventListener("pointerdown", event => { event.stopPropagation(); dragging = true; });
      bitrateSlider.addEventListener("pointerup", event => { event.stopPropagation(); dragging = false; });
      bitrateSlider.addEventListener("input", event => { event.stopPropagation(); dragging = true; describeSlider(); });
      bitrateSlider.addEventListener("change", event => {
        event.stopPropagation(); dragging = false;
        selectBitrate(Number(bitrateSlider.value) > bounds().max ? "source" : Number(bitrateSlider.value));
      });
      bitrateSlider.addEventListener("pointercancel", () => { dragging = false; render(); });
      bitrateSlider.addEventListener("blur", () => { dragging = false; render(); });
      bitrateAuto.addEventListener("change", event => {
        event.stopPropagation(); dragging = false;
        if (bitrateAuto.checked) onChange({ quality: resolution(), bitrate: "auto" });
        else selectBitrate(lastManual ?? defaultBitrate());
      });
      const endpoints = document.createElement("div"); endpoints.style.cssText = "display:flex;justify-content:space-between;font-size:11px;opacity:.7";
      const low = document.createElement("span"); low.textContent = "Low";
      const high = document.createElement("span"); high.textContent = "Source";
      endpoints.append(low, high);
      bitrateField.append(heading, bitrateLabel, bitrateSlider, endpoints); container.appendChild(bitrateField);
      // Keep Movi's click/keyboard shortcuts from seeking or closing Settings.
      for (const type of ["click", "keydown", "keyup"]) container.addEventListener(type, event => event.stopPropagation());
      status = document.createElement("p"); status.setAttribute("role", "status");
      status.style.cssText = "font:inherit;font-size:12px;white-space:normal;line-height:1.5;margin:0;opacity:.85";
      container.appendChild(status);
      auto = document.createElement("button"); auto.type = "button"; auto.className = "movi-settings-choice";
      auto.textContent = "Return to auto"; auto.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); dragging = false; previousResolution = "auto"; onChange({ quality: "auto", bitrate: "auto" }); });
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
    fill(qualitySelect, [["auto", "Auto"], ["source", "Source"],
      ...(state.options || []).map(option => [option.quality, `${option.quality}p`])], state.quality);
    if (!dragging) {
      bitrateAuto.checked = state.bitrate === "auto" && state.quality !== "source";
      bitrateSlider.min = String(bounds().min); bitrateSlider.max = String(bounds().max + bounds().step); bitrateSlider.step = String(bounds().step);
      if (typeof state.bitrate === "number") lastManual = clamp(state.bitrate);
      bitrateSlider.value = String(state.quality === "source" ? Number(bitrateSlider.max) : clamp(lastManual ?? defaultBitrate()));
      bitrateSlider.disabled = bitrateAuto.checked;
      bitrateSlider.style.opacity = bitrateAuto.checked ? ".45" : "1";
      describeSlider();
    }
    auto.hidden = state.quality === "auto" && state.bitrate === "auto";
    auto.style.display = auto.hidden ? "none" : "";
    if (status.textContent !== (state.status || "")) status.textContent = state.status || "";
  }
  function hook(name, replacement) {
    const original = video[name]?.bind(video);
    video[name] = (...args) => replacement(original, ...args);
  }
  hook("updateQualityMenu", original => state.enabled ? render() : original?.());
  hook("settingsRowAvailable", (original, selector, items) => selector === ".movi-quality-container" && state.enabled ? true : original?.(selector, items));
  hook("settingsRowValue", (original, page) => page === "quality" && state.enabled ? state.label || "Auto" : original?.(page));
  function renameResolution() {
    if (!state.enabled) return;
    const rootLabel = video.shadowRoot?.querySelector('[data-page="quality"] .movi-settings-row-label');
    if (rootLabel) rootLabel.textContent = "Resolution";
    if (video._settingsPage === "quality") {
      const title = video.shadowRoot?.querySelector(".movi-settings-page-title");
      if (title) title.textContent = "Resolution";
    }
  }
  hook("buildSettingsRoot", (original, ...args) => { const result = original?.(...args); renameResolution(); return result; });
  hook("openSettingsPage", (original, ...args) => { const result = original?.(...args); renameResolution(); return result; });
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
  return { update(next) {
    if (next.mediaVersion !== state.mediaVersion) dragging = false;
    state = next;
    if (!(state.options || []).some(option => option.quality === previousResolution)) previousResolution = "auto";
    if (lastManual != null) lastManual = clamp(lastManual);
    render();
  } };
}
