import { useEffect } from "react";
import { useWindowOpacityStore } from "../state/stores/window-opacity";

export function appliedWindowOpacity(opacity: number, host: Window["host"] | undefined): number {
  return host?.opaqueWindow === true ? 1 : opacity;
}

export function useWindowOpacityEffect(): void {
  const { opacity } = useWindowOpacityStore();

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--window-opacity",
      String(appliedWindowOpacity(opacity, window.host)),
    );
  }, [opacity]);
}
