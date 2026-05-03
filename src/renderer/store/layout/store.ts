import { create } from "zustand";
import { Grid } from "../../split-engine";
import type { Direction } from "../../split-engine";
import { stripDanglingTabs } from "./sanitize";
import type { LayoutLeaf, LayoutNode, LayoutState, SplitOrientation, WorkspaceLayout } from "./types";

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
    const { root: newRoot, newLeafId } = Grid.addView(layout.root, groupId, direction, crypto.randomUUID.bind(crypto));

    set((state) => ({
      byWorkspace: updateLayout(state.byWorkspace, workspaceId, () => ({
        root: newRoot,
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

      const { root: newRoot, hoistedSiblingLeafId } = Grid.removeView(root, groupId);

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

      if (!Grid.findView(layout.root, groupId)) return state;

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

      // Domain step: find owner leaf and compute updated tab list
      const owner = Grid.allLeaves(root).find((l) => l.tabIds.includes(tabId));
      if (!owner) return state;

      const idx = owner.tabIds.indexOf(tabId);
      const nextTabIds = owner.tabIds.filter((t) => t !== tabId);

      let nextActiveTabId = owner.activeTabId;
      if (nextActiveTabId === tabId) {
        nextActiveTabId = owner.tabIds[idx - 1] ?? owner.tabIds[idx + 1] ?? null;
      }
      if (nextActiveTabId !== null && !nextTabIds.includes(nextActiveTabId)) {
        nextActiveTabId = nextTabIds[0] ?? null;
      }

      const afterDetach = Grid.replaceLeaf(root, owner.id, (leaf) => ({
        ...leaf,
        tabIds: nextTabIds,
        activeTabId: nextActiveTabId,
      }));

      // Structural step: hoist if leaf is now empty and not the sole leaf
      let finalRoot = afterDetach;
      let nextActive = activeGroupId;

      if (nextTabIds.length === 0) {
        const { root: hoistedRoot, hoistedSiblingLeafId } = Grid.removeView(afterDetach, owner.id);
        if (hoistedSiblingLeafId !== null) {
          finalRoot = hoistedRoot;
          if (activeGroupId === owner.id) {
            nextActive = hoistedSiblingLeafId;
          }
        }
      }

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

      // Step 1a: domain detach — find owner leaf and compute updated tab list
      const owner = Grid.allLeaves(layout.root).find((l) => l.tabIds.includes(tabId));

      let intermediateRoot = layout.root;
      let nextActive = layout.activeGroupId;

      if (owner) {
        const idx = owner.tabIds.indexOf(tabId);
        const nextTabIds = owner.tabIds.filter((t) => t !== tabId);

        let nextActiveTabId = owner.activeTabId;
        if (nextActiveTabId === tabId) {
          nextActiveTabId = owner.tabIds[idx - 1] ?? owner.tabIds[idx + 1] ?? null;
        }
        if (nextActiveTabId !== null && !nextTabIds.includes(nextActiveTabId)) {
          nextActiveTabId = nextTabIds[0] ?? null;
        }

        intermediateRoot = Grid.replaceLeaf(layout.root, owner.id, (leaf) => ({
          ...leaf,
          tabIds: nextTabIds,
          activeTabId: nextActiveTabId,
        }));

        // Step 1b: structural — hoist if source leaf became empty
        if (nextTabIds.length === 0) {
          const { root: hoisted, hoistedSiblingLeafId } = Grid.removeView(intermediateRoot, owner.id);
          if (hoistedSiblingLeafId !== null) {
            intermediateRoot = hoisted;
            if (nextActive === owner.id) {
              nextActive = hoistedSiblingLeafId;
            }
          }
        }
      }

      // Step 2: attach to destination — re-query after possible hoist
      const destLeaf = Grid.findView(intermediateRoot, toGroupId);

      if (!destLeaf) {
        // Destination disappeared (hoisted away) — put tab in active group
        const fallbackLeaf = Grid.findView(intermediateRoot, nextActive);
        if (!fallbackLeaf) return state;

        const finalRoot = Grid.replaceLeaf(intermediateRoot, nextActive, (leaf) => {
          const tabIds = [...leaf.tabIds];
          if (index !== undefined) {
            tabIds.splice(index, 0, tabId);
          } else {
            tabIds.push(tabId);
          }
          return { ...leaf, tabIds, activeTabId: tabId };
        });

        return {
          byWorkspace: updateLayout(state.byWorkspace, workspaceId, () => ({
            root: finalRoot,
            activeGroupId: nextActive,
          })),
        };
      }

      const finalRoot = Grid.replaceLeaf(intermediateRoot, toGroupId, (leaf) => {
        const tabIds = [...leaf.tabIds];
        if (index !== undefined) {
          tabIds.splice(index, 0, tabId);
        } else {
          tabIds.push(tabId);
        }
        return { ...leaf, tabIds, activeTabId: tabId };
      });

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

      const leaf = Grid.findView(layout.root, groupId);
      if (!leaf || !leaf.tabIds.includes(tabId)) return state;

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

// Standalone helper for use outside the store (e.g. in tests that import helpers)
export function buildInitialLayout(): WorkspaceLayout {
  const root = makeEmptyLeaf();
  return { root, activeGroupId: root.id };
}

// Export makeEmptyLeaf for subscriber / hydration utilities
export { makeEmptyLeaf };

// Re-export LayoutNode type for subscriber
export type { LayoutNode };
