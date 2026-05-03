// ContentPool — mounts every workspace tab exactly once and positions each
// ContentHost over its corresponding group-slot element via absolute CSS.
//
// Placement contract:
//   ContentPool renders as `absolute inset-0` — this requires its parent
//   container to be `position: relative`. T7 (WorkspacePanel) is responsible
//   for establishing that positioning context by layering ContentPool as an
//   absolute sibling on top of the LayoutTree.

import { useRef } from "react";
import { useLayoutStore } from "../../../store/layout";
import { Grid } from "../../../lib/split-engine";
import { useTabsStore } from "../../../store/tabs";
import { ContentHost } from "./ContentHost";
import { ownerLeafIdOf } from "./selectors";

// ---------------------------------------------------------------------------
// ContentPool — renders one ContentHost per tab record
// ---------------------------------------------------------------------------

export function ContentPool({
  workspaceId,
  isWorkspaceActive,
}: {
  workspaceId: string;
  isWorkspaceActive: boolean;
}) {
  const poolRef = useRef<HTMLDivElement>(null);

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
    <div ref={poolRef} className="absolute inset-0 pointer-events-none">
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
            poolRef={poolRef}
          />
        );
      })}
    </div>
  );
}
