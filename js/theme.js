export function initializeTheme(button, storage = localStorage, root = document.documentElement, player = null) {
  let theme = storage.getItem("watchparty-theme") === "light" ? "light" : "dark";

  function applyTheme(nextTheme) {
    theme = nextTheme;
    root.dataset.theme = theme;
    player?.setAttribute("theme", theme);
    storage.setItem("watchparty-theme", theme);
    const nextLabel = theme === "light" ? "Switch to dark mode" : "Switch to light mode";
    button.setAttribute("aria-label", nextLabel);
    button.setAttribute("title", nextLabel);
    button.setAttribute("aria-pressed", String(theme === "light"));
  }

  button.addEventListener("click", () => applyTheme(theme === "light" ? "dark" : "light"));
  applyTheme(theme);
}