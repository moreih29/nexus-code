import { create } from "zustand";
import type { Direction } from "@/engine/split-engine";
import { Grid } from "@/engine/split-engine";
import { stripDanglingTabs } from "./sanitize";
import type {
  LayoutLeaf,
  LayoutNode,
  LayoutState,
  SplitOrientation,
  WorkspaceLayout,
} from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDirection(orientation: SplitOrientation, side: "before" | "after"): Direction {
  if (orientation === "horizontal") return side === "before" ? "left" : "right";
  return side === "before" ? "up" : "down";
}

function makeEmptyLeaf(): LayoutLeaf {
  return {
    kind: "leaf",
    id: crypto.randomUUID(),
    tabIds: [],
    activeTabId: null,
  };
}

function makeInitialLayout(): WorkspaceLayout {
  const root = makeEmptyLeaf();
  return { root, activeGroupId: root.id };
}

function updateLayout(
  byWorkspace: Record<string, WorkspaceLayout>,
  workspaceId: string,
  updater: (layout: WorkspaceLayout) => WorkspaceLayout,
): Record<string, WorkspaceLayout> {
  const existing = byWorkspace[workspaceId];
  if (!existing) return byWorkspace;
  return { ...byWorkspace, [workspaceId]: updater(existing) };
}

function computeNextActiveTabId(
  tabIds: string[],
  activeTabId: string | null,
  removedTabId: string,
): string | null {
  const nextTabIds = tabIds.filter((t) => t !== removedTabId);
  let next = activeTabId;
  if (next === removedTabId) {
    const idx = tabIds.indexOf(removedTabId);
    next = tabIds[idx - 1] ?? tabIds[idx + 1] ?? null;
  }
  if (next !== null && !nextTabIds.includes(next)) {
    next = nextTabIds[0] ?? null;
  }
  return next;
}

function detachTabFromLeaf(
  root: LayoutNode,
  leaf: LayoutLeaf,
  tabId: string,
  activeGroupId: string,
): { root: LayoutNode; activeGroupId: string } {
  const nextTabIds = leaf.tabIds.filter((t) => t !== tabId);
  const nextActiveTabId = computeNextActiveTabId(leaf.tabIds, leaf.activeTabId, tabId);

  const afterDetach = Grid.replaceLeaf(root, leaf.id, (l) => ({
    ...l,
    tabIds: nextTabIds,
    activeTabId: nextActiveTabId,
  }));

  if (nextTabIds.length === 0) {
    const { root: hoistedRoot, hoistedSiblingLeafId } = Grid.removeLeaf(afterDetach, leaf.id);
    if (hoistedSiblingLeafId !== null) {
      return {
        root: hoistedRoot,
        activeGroupId: activeGroupId === leaf.id ? hoistedSiblingLeafId : activeGroupId,
      };
    }
  }

  return { root: afterDetach, activeGroupId };
}

function attachTabToLeaf(
  root: LayoutNode,
  leafId: string,
  tabId: string,
  index: number | undefined,
): LayoutNode {
  return Grid.replaceLeaf(root, leafId, (leaf) => {
    const tabIds = [...leaf.tabIds];
    if (index !== undefined) {
      tabIds.splice(index, 0, tabId);
    } else {
      tabIds.push(tabId);
    }
    return { ...leaf, tabIds, activeTabId: tabId };
  });
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useLayoutStore = create<LayoutState>((set, get) => ({
  byWorkspace: {},

  ensureLayout(workspaceId) {
    if (get().byWorkspace[workspaceId]) return;
    set((state) => ({
      byWorkspace: {
        ...state.byWorkspace,
        [workspaceId]: makeInitialLayout(),
      },
    }));
  },

  splitGroup(workspaceId, groupId, orientation, side) {
    const layout = get().byWorkspace[workspaceId];
    if (!layout) return "";

    const direction = toDirection(orientation, side);
    const { root: newRoot, newLeafId } = Grid.addLeaf(
      layout.root,
      groupId,
      direction,
      crypto.randomUUID.bind(crypto),
    );

    set((state) => ({
      byWorkspace: updateLayout(state.byWorkspace, workspaceId, () => ({
        root: newRoot,
        activeGroupId: newLeafId,
      })),
    }));

    return newLeafId;
  },

  splitAndAttach(workspaceId, sourceLeafId, orientation, side, tabId) {
    const layout = get().byWorkspace[workspaceId];
    if (!layout) return "";

    const direction = toDirection(orientation, side);
    const { root: afterSplit, newLeafId } = Grid.addLeaf(
      layout.root,
      sourceLeafId,
      direction,
      crypto.randomUUID.bind(crypto),
    );

    // Attach tab to the freshly created leaf in the same set call so React
    // sees a single transition: source leaf → split with tab in new leaf.
    const finalRoot = Grid.replaceLeaf(afterSplit, newLeafId, (leaf) => ({
      ...leaf,
      tabIds: [tabId],
      activeTabId: tabId,
    }));

    set((state) => ({
      byWorkspace: updateLayout(state.byWorkspace, workspaceId, () => ({
        root: finalRoot,
        activeGroupId: newLeafId,
      })),
    }));

    return newLeafId;
  },

  closeGroup(workspaceId, groupId) {
    set((state) => {
      const layout = state.byWorkspace[workspaceId];
      if (!layout) return state;

      const { root, activeGroupId } = layout;

      // Sole leaf — just empty the tab list, don't remove the node
      if (root.kind === "leaf" && root.id === groupId) {
        const cleared: LayoutLeaf = { ...root, tabIds: [], activeTabId: null };
        return {
          byWorkspace: updateLayout(state.byWorkspace, workspaceId, () => ({
            root: cleared,
            activeGroupId: cleared.id,
          })),
        };
      }

      const { root: newRoot, hoistedSiblingLeafId } = Grid.removeLeaf(root, groupId);

      // Route activeGroupId: if active group was the one removed, move to hoisted sibling
      let nextActive = activeGroupId;
      if (activeGroupId === groupId) {
        nextActive = hoistedSiblingLeafId ?? Grid.leftmostLeaf(newRoot).id;
      }

      return {
        byWorkspace: updateLayout(state.byWorkspace, workspaceId, () => ({
          root: newRoot,
          activeGroupId: nextActive,
        })),
      };
    });
  },

  setSplitRatio(workspaceId, splitId, ratio) {
    set((state) => {
      const layout = state.byWorkspace[workspaceId];
      if (!layout) return state;

      const newRoot = Grid.setRatio(layout.root, splitId, ratio);

      return {
        byWorkspace: updateLayout(state.byWorkspace, workspaceId, (l) => ({
          ...l,
          root: newRoot,
        })),
      };
    });
  },

  setActiveGroup(workspaceId, groupId) {
    set((state) => {
      const layout = state.byWorkspace[workspaceId];
      // Equality guard — focusin / repeated clicks fire frequently and we
      // don't want to invalidate every layout-store subscriber on no-op
      // activations.
      if (!layout || layout.activeGroupId === groupId) return state;
      return {
        byWorkspace: updateLayout(state.byWorkspace, workspaceId, (l) => ({
          ...l,
          activeGroupId: groupId,
        })),
      };
    });
  },

  attachTab(workspaceId, groupId, tabId, index) {
    set((state) => {
      const layout = state.byWorkspace[workspaceId];
      if (!layout) return state;

      if (!Grid.findLeaf(layout.root, groupId)) return state;

      const newRoot = Grid.replaceLeaf(layout.root, groupId, (leaf) => {
        const tabIds = [...leaf.tabIds];
        const existingIdx = tabIds.indexOf(tabId);
        if (existingIdx !== -1) tabIds.splice(existingIdx, 1);

        if (index !== undefined) {
          tabIds.splice(index, 0, tabId);
        } else {
          tabIds.push(tabId);
        }

        return { ...leaf, tabIds, activeTabId: tabId };
      });

      return {
        byWorkspace: updateLayout(state.byWorkspace, workspaceId, (l) => ({
          ...l,
          root: newRoot,
        })),
      };
    });
  },

  detachTab(workspaceId, tabId) {
    set((state) => {
      const layout = state.byWorkspace[workspaceId];
      if (!layout) return state;

      const { root, activeGroupId } = layout;

      const owner = Grid.allLeaves(root).find((l) => l.tabIds.includes(tabId));
      if (!owner) return state;

      const { root: finalRoot, activeGroupId: nextActive } = detachTabFromLeaf(
        root,
        owner,
        tabId,
        activeGroupId,
      );

      return {
        byWorkspace: updateLayout(state.byWorkspace, workspaceId, () => ({
          root: finalRoot,
          activeGroupId: nextActive,
        })),
      };
    });
  },

  moveTab(workspaceId, tabId, toGroupId, index) {
    set((state) => {
      const layout = state.byWorkspace[workspaceId];
      if (!layout) return state;

      const owner = Grid.allLeaves(layout.root).find((l) => l.tabIds.includes(tabId));

      let intermediateRoot = layout.root;
      let nextActive = layout.activeGroupId;

      if (owner) {
        ({ root: intermediateRoot, activeGroupId: nextActive } = detachTabFromLeaf(
          layout.root,
          owner,
          tabId,
          nextActive,
        ));
      }

      // Attach to destination — re-query after possible hoist
      const destLeaf = Grid.findLeaf(intermediateRoot, toGroupId);
      const resolvedLeafId = destLeaf ? toGroupId : nextActive;

      if (!destLeaf) {
        // Destination disappeared (hoisted away) — put tab in active group
        if (!Grid.findLeaf(intermediateRoot, nextActive)) return state;
      }

      const finalRoot = attachTabToLeaf(intermediateRoot, resolvedLeafId, tabId, index);

      return {
        byWorkspace: updateLayout(state.byWorkspace, workspaceId, () => ({
          root: finalRoot,
          activeGroupId: nextActive,
        })),
      };
    });
  },

  setActiveTabInGroup({ workspaceId, groupId, tabId, activateGroup = true }) {
    set((state) => {
      const layout = state.byWorkspace[workspaceId];
      if (!layout) return state;

      const leaf = Grid.findLeaf(layout.root, groupId);
      if (!leaf?.tabIds.includes(tabId)) return state;

      const newRoot = Grid.replaceLeaf(layout.root, groupId, (l) => ({ ...l, activeTabId: tabId }));

      return {
        byWorkspace: updateLayout(state.byWorkspace, workspaceId, () => ({
          root: newRoot,
          activeGroupId: activateGroup ? groupId : layout.activeGroupId,
        })),
      };
    });
  },

  closeAllForWorkspace(workspaceId) {
    set((state) => {
      if (!(workspaceId in state.byWorkspace)) return state;
      const next = { ...state.byWorkspace };
      delete next[workspaceId];
      return { byWorkspace: next };
    });
  },

  hydrate(workspaceId, snapshot, knownTabIds) {
    const stripped = stripDanglingTabs(snapshot.root, knownTabIds);
    const sanitizedRoot = Grid.collapseEmptyLeaves(stripped);

    // Validate activeGroupId — must point to an existing leaf
    const leaves = Grid.allLeaves(sanitizedRoot);
    const leafIds = new Set(leaves.map((l) => l.id));

    let activeGroupId = snapshot.activeGroupId;
    if (!leafIds.has(activeGroupId)) {
      activeGroupId = Grid.leftmostLeaf(sanitizedRoot).id;
    }

    set((state) => ({
      byWorkspace: {
        ...state.byWorkspace,
        [workspaceId]: { root: sanitizedRoot, activeGroupId },
      },
    }));
  },
}));

// Re-export LayoutNode type for subscriber
export type { LayoutNode };
// Export makeEmptyLeaf for subscriber / hydration utilities
export { makeEmptyLeaf };
