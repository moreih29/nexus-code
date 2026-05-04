import type { LayoutNode, LayoutSplit } from "@/state/stores/layout";
import { ResizeHandle } from "../../ui/resize-handle";
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

  const firstBasis = `${split.ratio * 100}%`;
  const secondBasis = `${(1 - split.ratio) * 100}%`;

  return (
    <div
      ref={containerRef}
      className={`flex ${isHorizontal ? "flex-row" : "flex-col"} flex-1 min-h-0 min-w-0`}
    >
      {/* First child */}
      <div
        className="relative min-h-0 min-w-0 flex"
        style={{ flexBasis: firstBasis, flexGrow: 0, flexShrink: 0 }}
      >
        {renderNode(split.first)}

        {/* ResizeHandle is positioned relative to the first child's right/bottom edge */}
        <ResizeHandle {...sashProps} />
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
