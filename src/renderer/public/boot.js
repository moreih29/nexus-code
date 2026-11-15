// Boot script: runs synchronously from <head> before first paint (FOUC
// prevention). It is a file of its own, served next to index.html, so the
// app window's Content-Security-Policy runs it under script-src 'self'
// (main's window/app-csp.ts) without a hash for inline code.
//
// 1. Theme: reads localStorage["themePreference"] and applies it if it
//    matches a known theme id. Falls back to "github-dark" (DEFAULT_THEME).
//    The valid theme list is duplicated here because this script must run
//    before any module loads; keep it in sync with theme-sources.ts.
// 2. Window opacity: reads localStorage["windowOpacity"], sets the
//    --window-opacity CSS property if a valid number in [0,1] is stored,
//    except in an opaque window (host.opaqueWindow), where it has no effect.
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
