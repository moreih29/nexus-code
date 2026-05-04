import type { LayoutLeaf, LayoutNode } from "@/state/stores/layout";
import { GroupView } from "../group/group-view";

interface LeafPaneProps {
  workspaceId: string;
  leaf: LayoutLeaf;
  rootNode: LayoutNode;
  onActivateGroup: (groupId: string) => void;
  workspaceRootPath: string;
}

export function LeafPane({
  workspaceId,
  leaf,
  rootNode,
  onActivateGroup,
  workspaceRootPath,
}: LeafPaneProps) {
  const isRootLeaf = rootNode.kind === "leaf" && rootNode.id === leaf.id;
  return (
    <GroupView
      workspaceId={workspaceId}
      leaf={leaf}
      onActivateGroup={onActivateGroup}
      isRootLeaf={isRootLeaf}
      workspaceRootPath={workspaceRootPath}
    />
  );
}
