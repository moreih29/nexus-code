import { useRef } from "react";
import { useLayoutStore } from "@/store/layout";
import type { LayoutLeaf, LayoutNode, LayoutSplit } from "@/store/layout";
import { ResizeHandle } from "../ResizeHandle";
import { GroupView } from "./GroupView";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface LayoutTreeProps {
  workspaceId: string;
  root: LayoutNode;
  onActivateGroup: (groupId: string) => void;
  /** Root path used by GroupView when creating new terminal tabs. */
  workspaceRootPath: string;
}

// ---------------------------------------------------------------------------
// LayoutTree
// ---------------------------------------------------------------------------

export function LayoutTree({
  workspaceId,
  root,
  onActivateGroup,
  workspaceRootPath,
}: LayoutTreeProps) {
  return (
    <LayoutNode
      workspaceId={workspaceId}
      node={root}
      rootNode={root}
      onActivateGroup={onActivateGroup}
      workspaceRootPath={workspaceRootPath}
    />
  );
}

// ---------------------------------------------------------------------------
// Internal recursive renderer
// ---------------------------------------------------------------------------

interface LayoutNodeProps {
  workspaceId: string;
  node: LayoutNode;
  /** The root of the full tree — used to detect sole-leaf case. */
  rootNode: LayoutNode;
  onActivateGroup: (groupId: string) => void;
  workspaceRootPath: string;
}

function LayoutNodeRenderer({
  workspaceId,
  node,
  rootNode,
  onActivateGroup,
  workspaceRootPath,
}: LayoutNodeProps) {
  if (node.kind === "leaf") {
    const isRootLeaf = rootNode.kind === "leaf" && rootNode.id === node.id;
    return (
      <GroupView
        workspaceId={workspaceId}
        leaf={node as LayoutLeaf}
        onActivateGroup={onActivateGroup}
        isRootLeaf={isRootLeaf}
        workspaceRootPath={workspaceRootPath}
      />
    );
  }

  return (
    <SplitRenderer
      workspaceId={workspaceId}
      split={node as LayoutSplit}
      rootNode={rootNode}
      onActivateGroup={onActivateGroup}
      workspaceRootPath={workspaceRootPath}
    />
  );
}

// Alias for readability in the recursive call
const LayoutNode = LayoutNodeRenderer;

// ---------------------------------------------------------------------------
// SplitRenderer — handles a single LayoutSplit node
// ---------------------------------------------------------------------------

interface SplitRendererProps {
  workspaceId: string;
  split: LayoutSplit;
  rootNode: LayoutNode;
  onActivateGroup: (groupId: string) => void;
  workspaceRootPath: string;
}

function SplitRenderer({
  workspaceId,
  split,
  rootNode,
  onActivateGroup,
  workspaceRootPath,
}: SplitRendererProps) {
  const layoutStore = useLayoutStore();
  const containerRef = useRef<HTMLDivElement>(null);

  const isHorizontal = split.orientation === "horizontal";

  // The ResizeHandle calls onResize(value, persist) where `value` is:
  //   startValueRef.current + delta   (in pixels from drag start)
  // `startValueRef` is seeded from `value` prop on mousedown.
  //
  // Strategy: we pass `value = ratio * containerSize` so the handle's
  // arithmetic stays in pixel-land while we convert back to ratio on every
  // callback.
  //
  // We use 0 as a safe sentinel when the container is not yet mounted;
  // the handle won't fire before mount so this is fine.
  function getContainerSize(): number {
    const el = containerRef.current;
    if (!el) return 1;
    return isHorizontal ? el.getBoundingClientRect().width : el.getBoundingClientRect().height;
  }

  function handleResize(px: number, _persist: boolean) {
    const size = getContainerSize();
    if (size === 0) return;
    const ratio = Math.min(0.95, Math.max(0.05, px / size));
    layoutStore.setSplitRatio(workspaceId, split.id, ratio);
  }

  function handleReset() {
    layoutStore.setSplitRatio(workspaceId, split.id, 0.5);
  }

  const containerSizeForValue = getContainerSize();
  const handleValue = split.ratio * containerSizeForValue;

  // ResizeHandle sash orientation is perpendicular to the split direction:
  // - horizontal split (children side by side) → vertical sash (col-resize)
  // - vertical split (children stacked) → horizontal sash (row-resize)
  const sashOrientation = isHorizontal ? "vertical" : "horizontal";

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
        <LayoutNodeRenderer
          workspaceId={workspaceId}
          node={split.first}
          rootNode={rootNode}
          onActivateGroup={onActivateGroup}
          workspaceRootPath={workspaceRootPath}
        />

        {/* ResizeHandle is positioned relative to the first child's right/bottom edge */}
        <ResizeHandle
          orientation={sashOrientation}
          value={handleValue}
          min={containerSizeForValue * 0.05}
          max={containerSizeForValue * 0.95}
          onResize={handleResize}
          onReset={handleReset}
          ariaLabel={isHorizontal ? "Resize panels horizontally" : "Resize panels vertically"}
          placement={isHorizontal ? "rightCentered" : undefined}
        />
      </div>

      {/* Second child */}
      <div
        className="relative min-h-0 min-w-0 flex"
        style={{ flexBasis: secondBasis, flexGrow: 0, flexShrink: 0 }}
      >
        <LayoutNodeRenderer
          workspaceId={workspaceId}
          node={split.second}
          rootNode={rootNode}
          onActivateGroup={onActivateGroup}
          workspaceRootPath={workspaceRootPath}
        />
      </div>
    </div>
  );
}
