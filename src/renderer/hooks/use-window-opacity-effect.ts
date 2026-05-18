// src/renderer/hooks/use-window-opacity-effect.ts — Applies window opacity to the DOM.
//
// Subscribes to the window-opacity store and sets the --window-opacity CSS
// custom property on documentElement whenever the opacity changes.
//
// The CSS property is consumed by the island-surface and backdrop-surface
// utilities in globals.css via color-mix(). At opacity 1 (fully opaque,
// the default), surfaces render with no transparency.
//
// Called once in App.tsx alongside useThemeEffect().

import { useEffect } from "react";
import { useWindowOpacityStore } from "../state/stores/window-opacity";

export function useWindowOpacityEffect(): void {
  const { opacity } = useWindowOpacityStore();

  // Apply --window-opacity CSS property whenever opacity changes.
  useEffect(() => {
    document.documentElement.style.setProperty("--window-opacity", String(opacity));
  }, [opacity]);
}
