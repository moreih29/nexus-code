import { useRef } from "react";
import type { LayoutSplit } from "@/store/layout";
import { useLayoutStore } from "@/store/layout";
import { Grid } from "@/engine/split";

interface UseSplitSashOptions {
  workspaceId: string;
  split: LayoutSplit;
}

interface SashProps {
  orientation: "horizontal" | "vertical";
  value: number;
  min: number;
  max: number;
  onResize: (px: number, persist: boolean) => void;
  onReset: () => void;
  ariaLabel: string;
  placement?: "rightCentered";
}

interface UseSplitSashResult {
  containerRef: React.RefObject<HTMLDivElement | null>;
  sashProps: SashProps;
}

export function useSplitSash({ workspaceId, split }: UseSplitSashOptions): UseSplitSashResult {
  const layoutStore = useLayoutStore();
  const containerRef = useRef<HTMLDivElement>(null);

  const isHorizontal = split.orientation === "horizontal";

  function getContainerSize(): number {
    const el = containerRef.current;
    if (!el) return 1;
    return isHorizontal ? el.getBoundingClientRect().width : el.getBoundingClientRect().height;
  }

  function onResize(px: number, _persist: boolean) {
    const size = getContainerSize();
    if (size === 0) return;
    const ratio = Grid.pxToRatio(px, size);
    layoutStore.setSplitRatio(workspaceId, split.id, ratio);
  }

  function onReset() {
    layoutStore.setSplitRatio(workspaceId, split.id, 0.5);
  }

  const containerSize = getContainerSize();
  const sashOrientation = isHorizontal ? "vertical" : "horizontal";

  const sashProps: SashProps = {
    orientation: sashOrientation,
    value: split.ratio * containerSize,
    min: Grid.MIN_RATIO * containerSize,
    max: Grid.MAX_RATIO * containerSize,
    onResize,
    onReset,
    ariaLabel: isHorizontal ? "Resize panels horizontally" : "Resize panels vertically",
    placement: isHorizontal ? "rightCentered" : undefined,
  };

  return { containerRef, sashProps };
}
