import { useEffect } from "react";
import { useThemeStore } from "../state/stores/theme";

export function useThemeEffect(): void {
  const resolved = useThemeStore((s) => s.resolved);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolved);

    document.documentElement.dispatchEvent(
      new CustomEvent("nexus:theme-changed", { bubbles: false, detail: { themeId: resolved } }),
    );
  }, [resolved]);
}
