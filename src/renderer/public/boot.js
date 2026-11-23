(() => {
  const t = localStorage.getItem("themePreference");
  const themes = [
    "github-dark",
    "github-light",
    "dracula",
    "one-dark-pro",
    "monokai",
    "tokyo-night",
    "solarized-dark",
    "nord",
    "catppuccin-mocha",
    "gruvbox-dark",
  ];
  if (t && themes.includes(t)) {
    document.documentElement.setAttribute("data-theme", t);
  } else {
    document.documentElement.setAttribute("data-theme", "github-dark");
  }
  const o = localStorage.getItem("windowOpacity");
  if (o !== null && !window.host?.opaqueWindow) {
    const n = parseFloat(o);
    if (!Number.isNaN(n) && n >= 0 && n <= 1) {
      document.documentElement.style.setProperty("--window-opacity", String(n));
    }
  }
})();
