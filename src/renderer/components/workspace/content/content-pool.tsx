// ContentPool — mounts every workspace tab exactly once.
// Each ContentHost portals its content into the corresponding group-slot
// element via slotRegistry, or into the App-level view park when its
// workspace is inactive (see view-park.tsx).

import { Grid } from "@/engine/split";
import { useLayoutStore } from "../../../state/stores/layout";
import { useTabsStore } from "../../../state/stores/tabs";
import { ContentHost } from "./content-host";
import { ownerLeafIdOf } from "./selectors";

export function ContentPool({
  workspaceId,
  isWorkspaceActive,
}: {
  workspaceId: string;
  isWorkspaceActive: boolean;
}) {
  const tabRecord = useTabsStore((s) => s.byWorkspace[workspaceId] ?? {});
  const layout = useLayoutStore((s) => s.byWorkspace[workspaceId]);

  // Derive activeTabId for each leaf once so ContentHost can get isActiveTab.
  const activeTabByLeaf: Record<string, string | null> = {};
  if (layout) {
    for (const leaf of Grid.allLeaves(layout.root)) {
      activeTabByLeaf[leaf.id] = leaf.activeTabId;
    }
  }

  return (
    <>
      {Object.values(tabRecord).map((tab) => {
        const ownerLeafId = layout ? ownerLeafIdOf(layout.root, tab.id) : null;
        const isActiveTab = ownerLeafId !== null ? activeTabByLeaf[ownerLeafId] === tab.id : false;

        return (
          <ContentHost
            key={tab.id}
            workspaceId={workspaceId}
            tab={tab}
            ownerLeafId={ownerLeafId}
            isActiveTab={isActiveTab}
            isWorkspaceActive={isWorkspaceActive}
          />
        );
      })}
    </>
  );
}
