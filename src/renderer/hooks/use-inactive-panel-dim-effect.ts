// src/renderer/hooks/use-inactive-panel-dim-effect.ts — Applies the inactive-panel
// dim multiplier to the DOM.
//
// Subscribes to the inactive-panel-dim store and sets the --inactive-panel-dim
// CSS custom property on documentElement whenever it changes.
//
// The property is consumed by the --surface-island-inactive-veil token in the
// generated theme CSS via calc(): the veil's alpha is `themeDefaultAlpha *
// var(--inactive-panel-dim, 1)`. At 1 (the default) the veil renders with each
// theme's tuned alpha; 0 removes the dim entirely; 2 doubles it.
//
// Called once in App.tsx alongside useWindowOpacityEffect().

import { useEffect } from "react";
import { useInactivePanelDimStore } from "../state/stores/inactive-panel-dim";

export function useInactivePanelDimEffect(): void {
  const dim = useInactivePanelDimStore((s) => s.dim);

  useEffect(() => {
    document.documentElement.style.setProperty("--inactive-panel-dim", String(dim));
  }, [dim]);
}
