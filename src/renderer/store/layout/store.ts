import { create } from "zustand";
import {
  allLeaves,
  clampRatio,
  detachTabId,
  findLeaf,
  findSplit,
  insertSplit,
  leftmostLeaf,
  removeLeafAndHoist,
  replaceNode,
  sanitize,
} from "./helpers";
import type { LayoutLeaf, LayoutNode, LayoutState, WorkspaceLayout } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

    const newLeaf = makeEmptyLeaf();
    const newRoot = insertSplit(layout.root, groupId, orientation, side, newLeaf);

    set((state) => ({
      byWorkspace: updateLayout(state.byWorkspace, workspaceId, () => ({
        root: newRoot,
        activeGroupId: newLeaf.id,
      })),
    }));

    return newLeaf.id;
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

      const { root: newRoot, hoistedSiblingLeafId } = removeLeafAndHoist(root, groupId);

      // Route activeGroupId: if active group was the one removed, move to hoisted sibling
      let nextActive = activeGroupId;
      if (activeGroupId === groupId) {
        nextActive = hoistedSiblingLeafId ?? leftmostLeaf(newRoot).id;
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

      const split = findSplit(layout.root, splitId);
      if (!split) return state;

      const updated = { ...split, ratio: clampRatio(ratio) };
      const newRoot = replaceNode(layout.root, splitId, updated);

      return {
        byWorkspace: updateLayout(state.byWorkspace, workspaceId, (l) => ({
          ...l,
          root: newRoot,
        })),
      };
    });
  },

  setActiveGroup(workspaceId, groupId) {
    set((state) => ({
      byWorkspace: updateLayout(state.byWorkspace, workspaceId, (l) => ({
        ...l,
        activeGroupId: groupId,
      })),
    }));
  },

  attachTab(workspaceId, groupId, tabId, index) {
    set((state) => {
      const layout = state.byWorkspace[workspaceId];
      if (!layout) return state;

      const leaf = findLeaf(layout.root, groupId);
      if (!leaf) return state;

      const tabIds = [...leaf.tabIds];
      // Remove if already present to avoid duplicates
      const existingIdx = tabIds.indexOf(tabId);
      if (existingIdx !== -1) tabIds.splice(existingIdx, 1);

      if (index !== undefined) {
        tabIds.splice(index, 0, tabId);
      } else {
        tabIds.push(tabId);
      }

      const updated: LayoutLeaf = { ...leaf, tabIds, activeTabId: tabId };
      const newRoot = replaceNode(layout.root, groupId, updated);

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
      const { root: afterDetach, ownerLeafIdBefore, ownerLeafEmpty } = detachTabId(root, tabId);

      if (!ownerLeafIdBefore) return state;

      // If the owner leaf is now empty and is not the sole leaf → hoist
      let finalRoot = afterDetach;
      let nextActive = activeGroupId;

      if (ownerLeafEmpty) {
        const { root: hoistedRoot, hoistedSiblingLeafId } = removeLeafAndHoist(
          afterDetach,
          ownerLeafIdBefore,
        );
        if (hoistedSiblingLeafId !== null) {
          finalRoot = hoistedRoot;
          if (activeGroupId === ownerLeafIdBefore) {
            nextActive = hoistedSiblingLeafId;
          }
        }
      }

      // If activeGroup was this leaf and it's still present but empty → no reroute needed
      // (it stays empty as a placeholder only if it's the sole leaf)

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

      // Step 1: detach from current owner
      const { root: afterDetach, ownerLeafIdBefore, ownerLeafEmpty } = detachTabId(
        layout.root,
        tabId,
      );

      let intermediateRoot = afterDetach;
      let nextActive = layout.activeGroupId;

      if (ownerLeafIdBefore && ownerLeafEmpty) {
        const { root: hoisted, hoistedSiblingLeafId } = removeLeafAndHoist(
          afterDetach,
          ownerLeafIdBefore,
        );
        if (hoistedSiblingLeafId !== null) {
          intermediateRoot = hoisted;
          if (nextActive === ownerLeafIdBefore) {
            nextActive = hoistedSiblingLeafId;
          }
        }
      }

      // Step 2: attach to destination
      const destLeaf = findLeaf(intermediateRoot, toGroupId);
      if (!destLeaf) {
        // Destination disappeared (it was hoisted away) — put tab in active group
        const fallbackId = nextActive;
        const fallbackLeaf = findLeaf(intermediateRoot, fallbackId);
        if (!fallbackLeaf) return state;

        const tabIds = [...fallbackLeaf.tabIds];
        if (index !== undefined) {
          tabIds.splice(index, 0, tabId);
        } else {
          tabIds.push(tabId);
        }
        const updated: LayoutLeaf = { ...fallbackLeaf, tabIds, activeTabId: tabId };
        const newRoot = replaceNode(intermediateRoot, fallbackId, updated);
        return {
          byWorkspace: updateLayout(state.byWorkspace, workspaceId, () => ({
            root: newRoot,
            activeGroupId: nextActive,
          })),
        };
      }

      const tabIds = [...destLeaf.tabIds];
      if (index !== undefined) {
        tabIds.splice(index, 0, tabId);
      } else {
        tabIds.push(tabId);
      }
      const updated: LayoutLeaf = { ...destLeaf, tabIds, activeTabId: tabId };
      const finalRoot = replaceNode(intermediateRoot, toGroupId, updated);

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

      const leaf = findLeaf(layout.root, groupId);
      if (!leaf || !leaf.tabIds.includes(tabId)) return state;

      const updated: LayoutLeaf = { ...leaf, activeTabId: tabId };
      const newRoot = replaceNode(layout.root, groupId, updated);

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
    const sanitizedRoot = sanitize(snapshot.root, knownTabIds);

    // Validate activeGroupId — must point to an existing leaf
    const leaves = allLeaves(sanitizedRoot);
    const leafIds = new Set(leaves.map((l) => l.id));

    let activeGroupId = snapshot.activeGroupId;
    if (!leafIds.has(activeGroupId)) {
      activeGroupId = leftmostLeaf(sanitizedRoot).id;
    }

    set((state) => ({
      byWorkspace: {
        ...state.byWorkspace,
        [workspaceId]: { root: sanitizedRoot, activeGroupId },
      },
    }));
  },
}));

// Standalone helper for use outside the store (e.g. in tests that import helpers)
export function buildInitialLayout(): WorkspaceLayout {
  const root = makeEmptyLeaf();
  return { root, activeGroupId: root.id };
}

// Export makeEmptyLeaf for subscriber / hydration utilities
export { makeEmptyLeaf };

// Re-export LayoutNode type for subscriber
export type { LayoutNode };
