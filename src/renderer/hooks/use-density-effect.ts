// src/renderer/hooks/use-density-effect.ts — Applies density preference to the DOM.
//
// Subscribes to useDensityStore and synchronizes documentElement.dataset.density.
// 'default' removes the attribute entirely so :root[data-density='compact'] CSS
// overrides only activate for the compact variant (부재=토큰 fallback contract).
//
// Dispatches a "nexus:density-changed" CustomEvent on window for consumers that
// need to react to density changes without coupling to this hook.
//
// Called once in App.tsx (alongside useThemeEffect).

import { useEffect } from "react";
import { useDensityStore } from "../state/stores/density";

export function useDensityEffect(): void {
  const { preference } = useDensityStore();

  useEffect(() => {
    if (preference === "compact") {
      document.documentElement.setAttribute("data-density", "compact");
    } else {
      document.documentElement.removeAttribute("data-density");
    }

    window.dispatchEvent(new CustomEvent("nexus:density-changed", { detail: { preference } }));
  }, [preference]);
}
