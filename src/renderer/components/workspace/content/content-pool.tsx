// ContentPool — mounts every workspace tab exactly once.
// Each ContentHost portals its content into the corresponding group-slot
// element via slotRegistry. No absolute positioning layer needed here.

import React, { useCallback, useState } from "react";
import { Grid } from "@/engine/split";
import { useLayoutStore } from "../../../store/layout";
import { useTabsStore } from "../../../store/tabs";
import { ContentHost } from "./content-host";
import { ownerLeafIdOf } from "./selectors";

// ---------------------------------------------------------------------------
// HiddenPortalContext — stable off-screen container for ContentHost fallback
// ---------------------------------------------------------------------------

const HiddenPortalContext = React.createContext<HTMLElement | null>(null);

export function useHiddenPortalEl(): HTMLElement | null {
  return React.useContext(HiddenPortalContext);
}

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
  const tabRecord = useTabsStore((s) => s.byWorkspace[workspaceId] ?? {});
  const layout = useLayoutStore((s) => s.byWorkspace[workspaceId]);

  const [hiddenDivEl, setHiddenDivEl] = useState<HTMLDivElement | null>(null);
  const setHiddenEl = useCallback((el: HTMLDivElement | null) => setHiddenDivEl(el), []);

  // Derive activeTabId for each leaf once so ContentHost can get isActiveTab.
  const activeTabByLeaf: Record<string, string | null> = {};
  if (layout) {
    for (const leaf of Grid.allLeaves(layout.root)) {
      activeTabByLeaf[leaf.id] = leaf.activeTabId;
    }
  }

  return (
    <>
      <div
        ref={setHiddenEl}
        aria-hidden
        inert
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: 0,
          height: 0,
          overflow: "hidden",
          visibility: "hidden",
          pointerEvents: "none",
          contain: "strict",
        }}
      />
      <HiddenPortalContext.Provider value={hiddenDivEl}>
        {Object.values(tabRecord).map((tab) => {
          const ownerLeafId = layout ? ownerLeafIdOf(layout.root, tab.id) : null;
          const isActiveTab =
            ownerLeafId !== null ? activeTabByLeaf[ownerLeafId] === tab.id : false;

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
      </HiddenPortalContext.Provider>
    </>
  );
}
