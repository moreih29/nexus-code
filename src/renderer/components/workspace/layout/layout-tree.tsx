import type { LayoutLeaf, LayoutNode, LayoutSplit } from "@/store/layout";
import { LeafPane } from "./leaf-pane";
import { SplitPane } from "./split-pane";

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
    <LayoutNodeRenderer
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
    return (
      <LeafPane
        workspaceId={workspaceId}
        leaf={node as LayoutLeaf}
        rootNode={rootNode}
        onActivateGroup={onActivateGroup}
        workspaceRootPath={workspaceRootPath}
      />
    );
  }

  return (
    <SplitPane
      workspaceId={workspaceId}
      split={node as LayoutSplit}
      rootNode={rootNode}
      onActivateGroup={onActivateGroup}
      workspaceRootPath={workspaceRootPath}
      renderNode={(child) => (
        <LayoutNodeRenderer
          workspaceId={workspaceId}
          node={child}
          rootNode={rootNode}
          onActivateGroup={onActivateGroup}
          workspaceRootPath={workspaceRootPath}
        />
      )}
    />
  );
}
