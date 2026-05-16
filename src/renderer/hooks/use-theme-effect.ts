// src/renderer/hooks/use-theme-effect.ts — Applies resolved theme to the DOM.
//
// Subscribes to OS color-scheme changes (only when preference === "system"),
// and applies documentElement.setAttribute("data-theme", resolved) whenever
// the resolved theme changes.
//
// Extension points for task 15 (Monaco) and task 16 (xterm):
//   - The effect body dispatches a "nexus:theme-changed" CustomEvent on
//     documentElement. Monaco and xterm listeners attach to this event
//     to synchronize their own palette without coupling to this hook.
//
// Called once in App.tsx (or a dedicated ThemeProvider wrapper).

import { useEffect } from "react";
import { useThemeStore } from "../state/stores/theme";

export function useThemeEffect(): void {
  const { preference, resolved, resolveFromMediaQuery } = useThemeStore();

  // Apply data-theme attribute whenever resolved changes.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolved);

    // Extension point: Monaco/xterm synchronization hooks (task 15, 16).
    // Listeners register on this event without coupling to this hook.
    document.documentElement.dispatchEvent(
      new CustomEvent("nexus:theme-changed", { bubbles: false, detail: { themeId: resolved } }),
    );
  }, [resolved]);

  // OS media query subscription — only when preference === "system".
  // Unsubscribes automatically when preference changes to an explicit theme.
  useEffect(() => {
    if (preference !== "system") return;

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      resolveFromMediaQuery(e.matches);
    };
    mq.addEventListener("change", handler);
    // Sync immediately in case OS changed between renders.
    resolveFromMediaQuery(mq.matches);

    return () => {
      mq.removeEventListener("change", handler);
    };
  }, [preference, resolveFromMediaQuery]);
}
