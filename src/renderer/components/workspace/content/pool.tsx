import { memo } from "react";
import { useShallow } from "zustand/shallow";
import { Grid } from "@/engine";
import { useLayoutStore } from "../../../state/stores/layout";
import { useTabsStore } from "../../../state/stores/tabs";
import { ContentHost } from "./host";
import { ownerLeafIdOf } from "./selectors";

export const ContentPool = memo(function ContentPool({
  workspaceId,
  isWorkspaceActive,
}: {
  workspaceId: string;
  isWorkspaceActive: boolean;
}) {
  const tabIds = useTabsStore(useShallow((s) => Object.keys(s.byWorkspace[workspaceId] ?? {})));
  const layout = useLayoutStore((s) => s.byWorkspace[workspaceId]);

  const activeTabByLeaf: Record<string, string | null> = {};
  if (layout) {
    for (const leaf of Grid.allLeaves(layout.root)) {
      activeTabByLeaf[leaf.id] = leaf.activeTabId;
    }
  }

  return (
    <>
      {tabIds.map((tabId) => {
        const ownerLeafId = layout ? ownerLeafIdOf(layout.root, tabId) : null;
        const isActiveTab = ownerLeafId !== null && activeTabByLeaf[ownerLeafId] === tabId;

        return (
          <ContentHost
            key={tabId}
            workspaceId={workspaceId}
            tabId={tabId}
            ownerLeafId={ownerLeafId}
            isActiveTab={isActiveTab}
            isWorkspaceActive={isWorkspaceActive}
          />
        );
      })}
    </>
  );
});
