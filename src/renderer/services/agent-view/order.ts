/**
 * The order of the agent view's list: session keys by workspace or task,
 * and device IDs for the other computers. New rows come after saved rows.
 */

import type { RoomPeer } from "../../../shared/remote/room";

/** The orders by workspace id. */
export type AgentOrder = Readonly<Record<string, readonly string[]>>;

export const NO_ORDER: AgentOrder = {};

export type DropEdge = "before" | "after";

/** `sessions` in `order`: those it names first, as it names them, then the rest. */
export function orderSessions<T extends { readonly key: string }>(
  sessions: readonly T[],
  order: readonly string[] | undefined,
): readonly T[] {
  return orderRows(sessions, order, (session) => session.key);
}

type OrderedPeer = Pick<RoomPeer, "id" | "name" | "online">;

/** Default to online first and names within each group until the user sets an order. */
export function orderPeers<T extends OrderedPeer>(
  peers: readonly T[],
  order: readonly string[] | undefined,
): readonly T[] {
  if (order?.length) return orderRows(peers, order, (peer) => peer.id);
  return peers.toSorted(
    (a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name),
  );
}

function orderRows<T>(
  rows: readonly T[],
  order: readonly string[] | undefined,
  keyOf: (row: T) => string,
): readonly T[] {
  if (!order || order.length === 0 || rows.length < 2) return rows;
  const rank = new Map(order.map((key, i) => [key, i]));
  const listed = rows
    .filter((row) => rank.has(keyOf(row)))
    .sort((a, b) => (rank.get(keyOf(a)) ?? 0) - (rank.get(keyOf(b)) ?? 0));
  const ordered = [...listed, ...rows.filter((row) => !rank.has(keyOf(row)))];
  // The same array while nothing moved, so what is built from it is kept.
  return ordered.every((row, i) => row === rows[i]) ? rows : ordered;
}

/** `keys` with `moved` put just before or after `target`; as they were when either is missing. */
export function moveKey(
  keys: readonly string[],
  moved: string,
  target: string,
  edge: DropEdge,
): string[] {
  if (moved === target || !keys.includes(moved)) return [...keys];
  const rest = keys.filter((key) => key !== moved);
  const at = rest.indexOf(target);
  if (at < 0) return [...keys];
  rest.splice(edge === "before" ? at : at + 1, 0, moved);
  return rest;
}

/** Move among online slots, using the room roster to drop removed IDs. */
export function movePeer(
  peers: readonly OrderedPeer[],
  order: readonly string[],
  online: readonly string[],
  moved: string,
  target: string,
  edge: DropEdge,
): readonly string[] {
  const ids = orderPeers(peers, order).map(({ id }) => id);
  const movable = new Set(online);
  const next = moveKey(
    ids.filter((id) => movable.has(id)),
    moved,
    target,
    edge,
  );
  const reordered = reorderSubset(ids, next, (id) => id);
  return reordered === ids ? order : reordered;
}

/** Reorders the named slots, keeping all other keys in place. */
export function reorderSubset<T>(
  rows: readonly T[],
  requested: readonly string[],
  keyOf: (row: T) => string,
): readonly T[] {
  const byKey = new Map(rows.map((row) => [keyOf(row), row]));
  const selected = new Set(requested.filter((key) => byKey.has(key)));
  if (selected.size < 2) return rows;

  const replacements = Array.from(selected, (key) => byKey.get(key));
  let index = 0;
  const reordered = rows.map((row) =>
    selected.has(keyOf(row)) ? (replacements[index++] ?? row) : row,
  );
  return reordered.every((row, i) => row === rows[i]) ? rows : reordered;
}

/** What was stored, keeping only the agents `alive` knows, and the orders with any left. */
export function orderFromStore(
  stored: AgentOrder | undefined,
  alive: (key: string) => boolean,
): AgentOrder {
  if (!stored) return NO_ORDER;
  const order: Record<string, readonly string[]> = {};
  for (const [workspaceId, keys] of Object.entries(stored)) {
    const kept = keys.filter(alive);
    if (kept.length > 0) order[workspaceId] = kept;
  }
  return Object.keys(order).length > 0 ? order : NO_ORDER;
}

/** The orders as AppState keeps them. */
export function orderToStore(order: AgentOrder): Record<string, string[]> {
  return Object.fromEntries(Object.entries(order).map(([id, keys]) => [id, [...keys]]));
}
