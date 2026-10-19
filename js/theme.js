export function initializeTheme(button, storage, root = document.documentElement, player = null) {
  let theme = "dark";
  try {
    if (storage === undefined) storage = globalThis.localStorage;
    if (storage?.getItem("watchparty-theme") === "light") theme = "light";
  } catch {}

  function applyTheme(nextTheme) {
    theme = nextTheme;
    root.dataset.theme = theme;
    player?.setAttribute("theme", theme);
    try { storage?.setItem("watchparty-theme", theme); } catch {}
    const nextLabel = theme === "light" ? "Switch to dark mode" : "Switch to light mode";
    button.setAttribute("aria-label", nextLabel);
    button.setAttribute("title", nextLabel);
    button.setAttribute("aria-pressed", String(theme === "light"));
  }

  button.addEventListener("click", () => applyTheme(theme === "light" ? "dark" : "light"));
  applyTheme(theme);
}
