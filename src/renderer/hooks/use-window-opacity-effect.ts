// src/renderer/hooks/use-window-opacity-effect.ts — Applies window opacity to the DOM.
//
// Subscribes to the window-opacity store and sets the --window-opacity CSS
// custom property on documentElement whenever the opacity changes.
//
// The CSS property is consumed by the island-surface and backdrop-surface
// utilities in globals.css via color-mix(). At opacity 1 (fully opaque,
// the default), surfaces render with no transparency. An opaque window
// (host.opaqueWindow) stays at 1: nothing shows through it, and a lower
// value would only wash the surfaces out toward its white background.
//
// Called once in App.tsx alongside useThemeEffect().

import { useEffect } from "react";
import { useWindowOpacityStore } from "../state/stores/window-opacity";

/** The opacity a window applies: the preference, or 1 in an opaque window. */
export function appliedWindowOpacity(opacity: number, host: Window["host"] | undefined): number {
  return host?.opaqueWindow === true ? 1 : opacity;
}

export function useWindowOpacityEffect(): void {
  const { opacity } = useWindowOpacityStore();

  // Apply --window-opacity CSS property whenever opacity changes.
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--window-opacity",
      String(appliedWindowOpacity(opacity, window.host)),
    );
  }, [opacity]);
}
