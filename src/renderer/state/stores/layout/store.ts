import { create } from "zustand";
import type { Direction } from "@/engine";
import { Grid } from "@/engine";
import { activateTab, removeTab } from "@/engine/tabs";
import { stripDanglingTabs } from "./sanitize";
import type {
  LayoutLeaf,
  LayoutNode,
  LayoutState,
  SplitOrientation,
  WorkspaceLayout,
} from "./types";

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

function detachTabFromLeaf(
  root: LayoutNode,
  leaf: LayoutLeaf,
  tabId: string,
  activeGroupId: string,
): { root: LayoutNode; activeGroupId: string } {
  const nextLeaf = removeTab(leaf, tabId, "left");
  const afterDetach = Grid.replaceNode(root, leaf.id, nextLeaf);

  if (nextLeaf.tabIds.length === 0) {
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

function slotAfterRemoval(slot: number, removedIdx: number): number {
  return removedIdx !== -1 && removedIdx < slot ? slot - 1 : slot;
}

function attachTabToLeaf(
  root: LayoutNode,
  leafId: string,
  tabId: string,
  index: number | undefined,
): LayoutNode {
  return Grid.replaceLeaf(root, leafId, (leaf) => {
    const tabIds = [...leaf.tabIds];
    const existingIndex = tabIds.indexOf(tabId);
    if (existingIndex !== -1) tabIds.splice(existingIndex, 1);
    const at = index === undefined ? tabIds.length : slotAfterRemoval(index, existingIndex);
    tabIds.splice(at, 0, tabId);
    return activateTab(leaf, tabId, tabIds);
  });
}

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

    const finalRoot = attachTabToLeaf(afterSplit, newLeafId, tabId, undefined);

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

      if (root.kind === "leaf" && root.id === groupId) {
        const cleared: LayoutLeaf = { kind: "leaf", id: groupId, tabIds: [], activeTabId: null };
        return {
          byWorkspace: updateLayout(state.byWorkspace, workspaceId, () => ({
            root: cleared,
            activeGroupId: cleared.id,
          })),
        };
      }

      const { root: newRoot, hoistedSiblingLeafId } = Grid.removeLeaf(root, groupId);

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

      const newRoot = attachTabToLeaf(layout.root, groupId, tabId, index);

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

      if (owner && owner.id !== toGroupId) {
        ({ root: intermediateRoot, activeGroupId: nextActive } = detachTabFromLeaf(
          layout.root,
          owner,
          tabId,
          nextActive,
        ));
      }

      const destLeaf = Grid.findLeaf(intermediateRoot, toGroupId);
      const resolvedLeafId = destLeaf ? toGroupId : nextActive;

      if (!destLeaf) {
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

  setGroupTabOrder(workspaceId, groupId, tabIds) {
    set((state) => {
      const layout = state.byWorkspace[workspaceId];
      if (!layout) return state;
      const leaf = Grid.findLeaf(layout.root, groupId);
      if (!leaf || leaf.tabIds.length !== tabIds.length) return state;
      if (leaf.tabIds.every((id, i) => id === tabIds[i])) return state;
      const current = new Set(leaf.tabIds);
      if (new Set(tabIds).size !== tabIds.length || !tabIds.every((id) => current.has(id))) {
        return state;
      }
      const newRoot = Grid.replaceLeaf(layout.root, groupId, (l) => ({
        ...l,
        tabIds: [...tabIds],
      }));
      return {
        byWorkspace: updateLayout(state.byWorkspace, workspaceId, (l) => ({
          ...l,
          root: newRoot,
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

      const newRoot = Grid.replaceNode(layout.root, groupId, activateTab(leaf, tabId));

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

export type { LayoutNode };
