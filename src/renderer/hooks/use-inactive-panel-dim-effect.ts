import { useEffect } from "react";
import { useInactivePanelDimStore } from "../state/stores/inactive-panel-dim";

export function useInactivePanelDimEffect(): void {
  const dim = useInactivePanelDimStore((s) => s.dim);

  useEffect(() => {
    document.documentElement.style.setProperty("--inactive-panel-dim", String(dim));
  }, [dim]);
}
