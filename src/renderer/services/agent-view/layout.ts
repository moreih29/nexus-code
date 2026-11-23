import { type Direction, Grid, type SplitLeaf, type SplitNode } from "@/engine";
import { activateTab, removeTab } from "@/engine/tabs";
import { isRemoteFileKey, parseRemoteFileKey } from "../../../shared/fs/remote-file-key";

export interface AgentLayout {
  readonly root: SplitNode;
  readonly activeLeafId: string;
}

export type IdFactory = () => string;

export const newId: IdFactory = () => crypto.randomUUID();

export function emptyLayout(id: IdFactory = newId): AgentLayout {
  const leafId = id();
  return { root: emptyLeaf(leafId), activeLeafId: leafId };
}

function emptyLeaf(id: string): SplitLeaf {
  return { kind: "leaf", id, tabIds: [], activeTabId: null };
}

const REMOTE_KEY_PREFIX = "remote:";

export function remoteSessionKey(session: {
  deviceId: string;
  workspaceId: string;
  tabId: string;
}): string {
  return `${REMOTE_KEY_PREFIX}${session.deviceId}/${session.workspaceId}/${session.tabId}`;
}

export function isRemoteKey(key: string): boolean {
  return key.startsWith(REMOTE_KEY_PREFIX);
}

export function parseRemoteSessionKey(key: string) {
  if (!isRemoteKey(key)) return null;
  const [deviceId, workspaceId, tabId, ...rest] = key.slice(REMOTE_KEY_PREFIX.length).split("/");
  if (!deviceId || !workspaceId || !tabId || rest.length > 0) return null;
  return { deviceId, workspaceId, tabId };
}

export function parseSessionKey(key: string): { workspaceId: string; tabId: string } | null {
  if (isRemoteKey(key) || isRemoteFileKey(key)) return null;
  const colon = key.indexOf(":");
  if (colon <= 0 || colon === key.length - 1) return null;
  return { workspaceId: key.slice(0, colon), tabId: key.slice(colon + 1) };
}

export function leafHolding(root: SplitNode, key: string): SplitLeaf | null {
  return Grid.findLeafByTab(root, (id) => id === key)?.leaf ?? null;
}

export function selectHeldKey(layout: AgentLayout, key: string): AgentLayout | null {
  const holder = leafHolding(layout.root, key);
  return holder ? selectKey(layout, holder.id, key) : null;
}

export function leafShowing(root: SplitNode, key: string): string | null {
  return Grid.allLeaves(root).find((leaf) => leaf.activeTabId === key)?.id ?? null;
}

export function heldKeys(root: SplitNode): string[] {
  return Grid.allLeaves(root).flatMap((leaf) => leaf.tabIds);
}

export function activeKey(layout: AgentLayout): string | null {
  return Grid.findLeaf(layout.root, layout.activeLeafId)?.activeTabId ?? null;
}

function activeLeaf(layout: AgentLayout): SplitLeaf {
  return Grid.findLeaf(layout.root, layout.activeLeafId) ?? Grid.leftmostLeaf(layout.root);
}

export function openKey(layout: AgentLayout, key: string, leafId?: string): AgentLayout {
  const holder = leafHolding(layout.root, key);
  if (holder) return selectKey(layout, holder.id, key);
  const target =
    (leafId !== undefined ? Grid.findLeaf(layout.root, leafId) : null) ?? activeLeaf(layout);
  return {
    root: Grid.replaceNode(
      layout.root,
      target.id,
      activateTab(target, key, [...target.tabIds, key]),
    ),
    activeLeafId: target.id,
  };
}

export function selectKey(layout: AgentLayout, leafId: string, key: string): AgentLayout {
  const leaf = Grid.findLeaf(layout.root, leafId);
  if (!leaf?.tabIds.includes(key)) return layout;
  if (leaf.activeTabId === key && layout.activeLeafId === leafId) return layout;
  return {
    root:
      leaf.activeTabId === key
        ? layout.root
        : Grid.replaceNode(layout.root, leafId, activateTab(leaf, key)),
    activeLeafId: leafId,
  };
}

export function setActiveLeaf(layout: AgentLayout, leafId: string): AgentLayout {
  if (layout.activeLeafId === leafId || !Grid.findLeaf(layout.root, leafId)) return layout;
  return { ...layout, activeLeafId: leafId };
}

export function removeKey(layout: AgentLayout, key: string): AgentLayout {
  const holder = leafHolding(layout.root, key);
  if (!holder) return layout;
  const nextLeaf = removeTab(holder, key, "right");
  if (nextLeaf.tabIds.length === 0) return closeLeaf(layout, holder.id);
  return {
    ...layout,
    root: Grid.replaceNode(layout.root, holder.id, nextLeaf),
  };
}

export function closeLeaf(layout: AgentLayout, leafId: string): AgentLayout {
  if (!Grid.findLeaf(layout.root, leafId)) return layout;
  if (layout.root.kind === "leaf") {
    return {
      root: emptyLeaf(leafId),
      activeLeafId: layout.root.id,
    };
  }
  const { root, hoistedSiblingLeafId } = Grid.removeLeaf(layout.root, leafId);
  const activeLeafId =
    layout.activeLeafId === leafId
      ? (hoistedSiblingLeafId ?? Grid.leftmostLeaf(root).id)
      : layout.activeLeafId;
  return { root, activeLeafId };
}

export function moveKey(
  layout: AgentLayout,
  key: string,
  toLeafId: string,
  index?: number,
): AgentLayout {
  const target = Grid.findLeaf(layout.root, toLeafId);
  if (!target) return layout;
  const holder = leafHolding(layout.root, key);
  if (holder?.id === toLeafId) {
    const without = target.tabIds.filter((id) => id !== key);
    const at = clampIndex(index ?? without.length, without.length);
    const tabIds = [...without.slice(0, at), key, ...without.slice(at)];
    return {
      root: Grid.replaceNode(layout.root, toLeafId, activateTab(target, key, tabIds)),
      activeLeafId: toLeafId,
    };
  }
  const lifted = holder ? removeKey(layout, key) : layout;
  const landing = Grid.findLeaf(lifted.root, toLeafId);
  if (!landing) return layout;
  const at = clampIndex(index ?? landing.tabIds.length, landing.tabIds.length);
  const tabIds = [...landing.tabIds.slice(0, at), key, ...landing.tabIds.slice(at)];
  return {
    root: Grid.replaceNode(lifted.root, toLeafId, activateTab(landing, key, tabIds)),
    activeLeafId: toLeafId,
  };
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, length));
}

export function splitLeaf(
  layout: AgentLayout,
  leafId: string,
  direction: Direction,
  key?: string,
  id: IdFactory = newId,
): AgentLayout {
  const leaf = Grid.findLeaf(layout.root, leafId);
  if (!leaf) return layout;
  const moving = key ?? (leaf.tabIds.length > 1 ? (leaf.activeTabId ?? undefined) : undefined);
  if (moving !== undefined && leaf.tabIds.length === 1 && leaf.tabIds[0] === moving) return layout;
  const { root, newLeafId } = Grid.addLeaf(layout.root, leafId, direction, id);
  if (!newLeafId) return layout;
  const split = { root, activeLeafId: newLeafId };
  return moving !== undefined ? moveKey(split, moving, newLeafId) : split;
}

export function placeKey(
  layout: AgentLayout,
  key: string,
  leafId: string,
  side?: Direction,
  index?: number,
  id: IdFactory = newId,
): AgentLayout {
  if (side !== undefined) return splitLeaf(layout, leafId, side, key, id);
  if (index === undefined && leafHolding(layout.root, key)?.id === leafId) {
    return selectKey(layout, leafId, key);
  }
  return moveKey(layout, key, leafId, index);
}

export function showBeside(
  layout: AgentLayout,
  key: string,
  besideLeafId: string,
  id: IdFactory = newId,
): AgentLayout {
  const holder = leafHolding(layout.root, key);
  if (holder && holder.id !== besideLeafId) return selectKey(layout, holder.id, key);
  if (holder?.activeTabId === key) return layout;
  const others = Grid.allLeaves(layout.root).filter((leaf) => leaf.id !== besideLeafId);
  const target = others.find((leaf) => leaf.id === layout.activeLeafId) ?? others[0];
  if (target) return moveKey(layout, key, target.id);
  return splitLeaf(layout, besideLeafId, "right", key, id);
}

export function setRatio(layout: AgentLayout, splitId: string, ratio: number): AgentLayout {
  const root = Grid.setRatio(layout.root, splitId, ratio);
  return root === layout.root ? layout : { ...layout, root };
}

export function cycleTab(layout: AgentLayout, delta: number): AgentLayout {
  const leaf = activeLeaf(layout);
  if (leaf.tabIds.length < 2) return layout;
  const at = leaf.activeTabId === null ? 0 : leaf.tabIds.indexOf(leaf.activeTabId);
  const next = leaf.tabIds[(at + delta + leaf.tabIds.length) % leaf.tabIds.length];
  return next === undefined ? layout : selectKey(layout, leaf.id, next);
}

export function cycleLeaf(layout: AgentLayout, delta: number): AgentLayout {
  const leaves = Grid.allLeaves(layout.root);
  if (leaves.length < 2) return layout;
  const at = Math.max(
    0,
    leaves.findIndex((leaf) => leaf.id === layout.activeLeafId),
  );
  const next = leaves[(at + delta + leaves.length) % leaves.length];
  return next ? setActiveLeaf(layout, next.id) : layout;
}

export function pruneKeys(layout: AgentLayout, alive: (key: string) => boolean): AgentLayout {
  let next = layout;
  for (const key of heldKeys(layout.root)) {
    if (!alive(key)) next = removeKey(next, key);
  }
  return next;
}

export function sanitizeLayout(root: SplitNode, activeLeafId: string): AgentLayout {
  const seen = new Set<string>();
  const clean = (node: SplitNode): SplitNode => {
    if (node.kind === "split")
      return { ...node, first: clean(node.first), second: clean(node.second) };
    const tabIds = node.tabIds.filter((key) => {
      if (
        seen.has(key) ||
        (!parseSessionKey(key) && !isRemoteKey(key) && !parseRemoteFileKey(key))
      ) {
        return false;
      }
      seen.add(key);
      return true;
    });
    const activeTabId =
      node.activeTabId !== null && tabIds.includes(node.activeTabId)
        ? node.activeTabId
        : (tabIds[0] ?? null);
    return { kind: "leaf", id: node.id, tabIds, activeTabId };
  };
  const cleaned = clean(root);
  return {
    root: cleaned,
    activeLeafId: Grid.findLeaf(cleaned, activeLeafId)
      ? activeLeafId
      : Grid.leftmostLeaf(cleaned).id,
  };
}
