// src/renderer/hooks/use-theme-effect.ts — Applies resolved theme to the DOM.
//
// Sets documentElement.setAttribute("data-theme", resolved) whenever the
// resolved theme changes, and dispatches a "nexus:theme-changed" CustomEvent
// for Monaco / xterm listeners.
//
// OS Auto (system) preference was removed when external themes replaced the
// first-party warm/cool pair (see state/stores/theme.ts). The matchMedia
// subscription is no longer needed.
//
// Called once in App.tsx (or a dedicated ThemeProvider wrapper).

import { useEffect } from "react";
import { useThemeStore } from "../state/stores/theme";

export function useThemeEffect(): void {
  const resolved = useThemeStore((s) => s.resolved);

  // Apply data-theme attribute whenever resolved changes.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolved);

    // Monaco / xterm subscribe to this event to swap their own palettes
    // without coupling to this hook.
    document.documentElement.dispatchEvent(
      new CustomEvent("nexus:theme-changed", { bubbles: false, detail: { themeId: resolved } }),
    );
  }, [resolved]);
}
