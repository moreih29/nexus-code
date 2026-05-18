import type { LayoutNode, LayoutSplit } from "@/state/stores/layout";
import { ResizeHandleRatio } from "../../ui/resize-handle-ratio";
import { useSplitSash } from "./use-split-sash";

interface SplitPaneProps {
  workspaceId: string;
  split: LayoutSplit;
  rootNode: LayoutNode;
  onActivateGroup: (groupId: string) => void;
  workspaceRootPath: string;
  renderNode: (node: LayoutNode) => React.ReactNode;
}

export function SplitPane({ workspaceId, split, renderNode }: SplitPaneProps) {
  const isHorizontal = split.orientation === "horizontal";
  const { containerRef, sashProps } = useSplitSash({ workspaceId, split });

  const firstBasis = `calc(${split.ratio * 100}% - 3px)`;
  const secondBasis = `calc(${(1 - split.ratio) * 100}% - 3px)`;

  return (
    <div
      ref={containerRef}
      className={`flex ${isHorizontal ? "flex-row" : "flex-col"} flex-1 min-h-0 min-w-0 gap-[6px]`}
    >
      {/* First child */}
      <div
        className="relative min-h-0 min-w-0 flex"
        style={{ flexBasis: firstBasis, flexGrow: 0, flexShrink: 0 }}
      >
        {renderNode(split.first)}

        {/* ResizeHandleRatio is positioned relative to the first child's right/bottom edge */}
        <ResizeHandleRatio {...sashProps} />
      </div>

      {/* Second child */}
      <div
        className="relative min-h-0 min-w-0 flex"
        style={{ flexBasis: secondBasis, flexGrow: 0, flexShrink: 0 }}
      >
        {renderNode(split.second)}
      </div>
    </div>
  );
}
