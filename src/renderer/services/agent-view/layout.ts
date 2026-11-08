/**
 * The agent view's panels: a binary tree of splits whose leaves hold agents
 * by session key, the way a workspace's groups hold its tabs. Pure: each
 * change returns a new layout, so the store, the commands and the tests all
 * go through the same steps.
 */

import { type Direction, Grid, type SplitLeaf, type SplitNode } from "@/engine";

export interface AgentLayout {
  readonly root: SplitNode;
  /** The panel the keyboard and new agents go to. */
  readonly activeLeafId: string;
}

export type IdFactory = () => string;

export const newId: IdFactory = () => crypto.randomUUID();

/** One empty panel. */
export function emptyLayout(id: IdFactory = newId): AgentLayout {
  const leafId = id();
  return { root: emptyLeaf(leafId), activeLeafId: leafId };
}

function emptyLeaf(id: string): SplitLeaf {
  return { kind: "leaf", id, tabIds: [], activeTabId: null };
}

/** The workspace and tab a session key names; null for one that names neither. */
export function parseSessionKey(key: string): { workspaceId: string; tabId: string } | null {
  const colon = key.indexOf(":");
  if (colon <= 0 || colon === key.length - 1) return null;
  return { workspaceId: key.slice(0, colon), tabId: key.slice(colon + 1) };
}

/** The panel holding `key`, whether it shows it or keeps it behind another tab. */
export function leafHolding(root: SplitNode, key: string): SplitLeaf | null {
  return Grid.findLeafByTab(root, (id) => id === key)?.leaf ?? null;
}

/** The panel showing `key` in front; null when no panel does. */
export function leafShowing(root: SplitNode, key: string): string | null {
  return Grid.allLeaves(root).find((leaf) => leaf.activeTabId === key)?.id ?? null;
}

/** Every agent the panels hold. */
export function heldKeys(root: SplitNode): string[] {
  return Grid.allLeaves(root).flatMap((leaf) => leaf.tabIds);
}

/** The agent in front of the active panel. */
export function activeKey(layout: AgentLayout): string | null {
  return Grid.findLeaf(layout.root, layout.activeLeafId)?.activeTabId ?? null;
}

/** The active panel, else the first, so a stale id still lands somewhere. */
function activeLeaf(layout: AgentLayout): SplitLeaf {
  return Grid.findLeaf(layout.root, layout.activeLeafId) ?? Grid.leftmostLeaf(layout.root);
}

function withLeaf(root: SplitNode, leafId: string, update: (leaf: SplitLeaf) => SplitLeaf) {
  return Grid.replaceLeaf(root, leafId, update);
}

/**
 * Shows `key`: in front of the panel already holding it, else added to
 * `leafId` (the active panel by default). Either way that panel becomes the
 * active one.
 */
export function openKey(layout: AgentLayout, key: string, leafId?: string): AgentLayout {
  const holder = leafHolding(layout.root, key);
  if (holder) return selectKey(layout, holder.id, key);
  const target =
    (leafId !== undefined ? Grid.findLeaf(layout.root, leafId) : null) ?? activeLeaf(layout);
  return {
    root: withLeaf(layout.root, target.id, (leaf) => ({
      ...leaf,
      tabIds: [...leaf.tabIds, key],
      activeTabId: key,
    })),
    activeLeafId: target.id,
  };
}

/** Brings `key` to the front of `leafId` and makes that panel the active one. */
export function selectKey(layout: AgentLayout, leafId: string, key: string): AgentLayout {
  const leaf = Grid.findLeaf(layout.root, leafId);
  if (!leaf?.tabIds.includes(key)) return layout;
  if (leaf.activeTabId === key && layout.activeLeafId === leafId) return layout;
  return {
    root:
      leaf.activeTabId === key
        ? layout.root
        : Grid.replaceLeaf(layout.root, leafId, (l) => ({ ...l, activeTabId: key })),
    activeLeafId: leafId,
  };
}

export function setActiveLeaf(layout: AgentLayout, leafId: string): AgentLayout {
  if (layout.activeLeafId === leafId || !Grid.findLeaf(layout.root, leafId)) return layout;
  return { ...layout, activeLeafId: leafId };
}

/**
 * Takes `key` out of the panels; the agent goes on in its workspace. A
 * panel left empty closes, unless it is the only one.
 */
export function removeKey(layout: AgentLayout, key: string): AgentLayout {
  const holder = leafHolding(layout.root, key);
  if (!holder) return layout;
  const index = holder.tabIds.indexOf(key);
  const tabIds = holder.tabIds.filter((id) => id !== key);
  if (tabIds.length === 0) return closeLeaf(layout, holder.id);
  const activeTabId =
    holder.activeTabId === key
      ? (tabIds[Math.min(index, tabIds.length - 1)] ?? null)
      : holder.activeTabId;
  return {
    ...layout,
    root: withLeaf(layout.root, holder.id, (leaf) => ({ ...leaf, tabIds, activeTabId })),
  };
}

/**
 * Closes the panel and takes its agents out of the view; the only panel
 * left is emptied instead.
 */
export function closeLeaf(layout: AgentLayout, leafId: string): AgentLayout {
  if (!Grid.findLeaf(layout.root, leafId)) return layout;
  if (layout.root.kind === "leaf") {
    return {
      root: { ...layout.root, tabIds: [], activeTabId: null },
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

/**
 * Moves `key` into `toLeafId` at `index` (the end by default) and shows it
 * there. The panel it left closes once empty.
 */
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
      root: withLeaf(layout.root, toLeafId, (leaf) => ({ ...leaf, tabIds, activeTabId: key })),
      activeLeafId: toLeafId,
    };
  }
  // Out of the panel it was in first: closing that panel can hoist the
  // target, but never removes it.
  const lifted = holder ? removeKey(layout, key) : layout;
  const landing = Grid.findLeaf(lifted.root, toLeafId);
  if (!landing) return layout;
  const at = clampIndex(index ?? landing.tabIds.length, landing.tabIds.length);
  const tabIds = [...landing.tabIds.slice(0, at), key, ...landing.tabIds.slice(at)];
  return {
    root: withLeaf(lifted.root, toLeafId, (leaf) => ({ ...leaf, tabIds, activeTabId: key })),
    activeLeafId: toLeafId,
  };
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, length));
}

/**
 * Splits `leafId` toward `direction` and makes the new panel the active one.
 * With `key`, the agent moves into the new panel. Without one, the panel's
 * front agent moves there when the panel holds others to keep showing;
 * otherwise the new panel starts empty, for the next agent picked.
 */
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
  // The only agent of the panel split beside itself: nothing would change.
  if (moving !== undefined && leaf.tabIds.length === 1 && leaf.tabIds[0] === moving) return layout;
  const { root, newLeafId } = Grid.addLeaf(layout.root, leafId, direction, id);
  if (!newLeafId) return layout;
  const split = { root, activeLeafId: newLeafId };
  return moving !== undefined ? moveKey(split, moving, newLeafId) : split;
}

/**
 * Puts `key` where it was dropped on `leafId`: a new panel toward `side`,
 * else into the panel at `index` (the end by default). Dropped back on the
 * panel holding it, without an index, it just comes to the front.
 */
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

/**
 * Shows `key` beside the panel `besideLeafId`, not over what it shows: in
 * front of the panel holding it when that is another, else in another
 * panel (the active one when it is another), else in a new panel split off
 * to its right. The panel it lands in becomes the active one. One that
 * panel shows already stays.
 */
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

/** Steps the active panel's front agent `delta` tabs along, wrapping around. */
export function cycleTab(layout: AgentLayout, delta: number): AgentLayout {
  const leaf = activeLeaf(layout);
  if (leaf.tabIds.length < 2) return layout;
  const at = leaf.activeTabId === null ? 0 : leaf.tabIds.indexOf(leaf.activeTabId);
  const next = leaf.tabIds[(at + delta + leaf.tabIds.length) % leaf.tabIds.length];
  return next === undefined ? layout : selectKey(layout, leaf.id, next);
}

/** Makes the panel `delta` along, in reading order, the active one, wrapping around. */
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

/**
 * Takes out the agents `alive` no longer knows (a tab closed, a workspace
 * removed); the panels they leave empty close.
 */
export function pruneKeys(layout: AgentLayout, alive: (key: string) => boolean): AgentLayout {
  let next = layout;
  for (const key of heldKeys(layout.root)) {
    if (!alive(key)) next = removeKey(next, key);
  }
  return next;
}

/**
 * A layout safe to show from what was stored: each agent in one panel, each
 * panel's front agent one it holds, and an active panel that exists.
 */
export function sanitizeLayout(root: SplitNode, activeLeafId: string): AgentLayout {
  const seen = new Set<string>();
  const clean = (node: SplitNode): SplitNode => {
    if (node.kind === "split")
      return { ...node, first: clean(node.first), second: clean(node.second) };
    const tabIds = node.tabIds.filter((key) => {
      if (seen.has(key) || parseSessionKey(key) === null) return false;
      seen.add(key);
      return true;
    });
    const activeTabId =
      node.activeTabId !== null && tabIds.includes(node.activeTabId)
        ? node.activeTabId
        : (tabIds[0] ?? null);
    return { ...node, tabIds, activeTabId };
  };
  const cleaned = clean(root);
  return {
    root: cleaned,
    activeLeafId: Grid.findLeaf(cleaned, activeLeafId)
      ? activeLeafId
      : Grid.leftmostLeaf(cleaned).id,
  };
}
