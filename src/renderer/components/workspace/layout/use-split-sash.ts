import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Grid } from "@/engine";
import type { LayoutSplit } from "@/state/stores/layout";
import { useLayoutStore } from "@/state/stores/layout";

interface UseSplitSashOptions {
  workspaceId: string;
  split: LayoutSplit;
}

interface SashProps {
  orientation: "horizontal" | "vertical";
  ratio: number;
  minRatio: number;
  maxRatio: number;
  getContainerSize: () => number;
  onResize: (ratio: number, persist: boolean) => void;
  onReset: () => void;
  ariaLabel: string;
  placement?: "rightCentered";
}

interface UseSplitSashResult {
  containerRef: React.RefObject<HTMLDivElement | null>;
  sashProps: SashProps;
}

export function useSplitSash({ workspaceId, split }: UseSplitSashOptions): UseSplitSashResult {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);

  const isHorizontal = split.orientation === "horizontal";

  function getContainerSize(): number {
    const el = containerRef.current;
    if (!el) return 0;
    return isHorizontal ? el.getBoundingClientRect().width : el.getBoundingClientRect().height;
  }

  function onResize(ratio: number, _persist: boolean) {
    useLayoutStore.getState().setSplitRatio(workspaceId, split.id, ratio);
  }

  function onReset() {
    useLayoutStore.getState().setSplitRatio(workspaceId, split.id, 0.5);
  }

  const sashOrientation = isHorizontal ? "vertical" : "horizontal";

  const sashProps: SashProps = {
    orientation: sashOrientation,
    ratio: split.ratio,
    minRatio: Grid.MIN_RATIO,
    maxRatio: Grid.MAX_RATIO,
    getContainerSize,
    onResize,
    onReset,
    ariaLabel: isHorizontal ? t("resize.horizontal") : t("resize.vertical"),
    placement: isHorizontal ? "rightCentered" : undefined,
  };

  return { containerRef, sashProps };
}
