/**
 * The order of the agent view's list: session keys by workspace or task,
 * and device IDs for the other computers. New rows come at the end.
 */

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

export function orderPeers<T extends { readonly id: string }>(
  peers: readonly T[],
  order: readonly string[],
): readonly T[] {
  return orderRows(peers, order, (peer) => peer.id);
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

/** Replace the group's slots in the shared order, using the room roster to drop removed IDs. */
export function movePeer(
  peers: readonly { readonly id: string }[],
  order: readonly string[],
  group: readonly string[],
  moved: string,
  target: string,
  edge: DropEdge,
): readonly string[] {
  const ids = orderPeers(peers, order).map(({ id }) => id);
  const members = new Set(group);
  const current = ids.filter((id) => members.has(id));
  const next = moveKey(current, moved, target, edge);
  if (next.every((id, index) => id === current[index])) return order;
  const replacements = new Map(current.map((id, index) => [id, next[index]]));
  return ids.map((id) => replacements.get(id) ?? id);
}

/** What was stored, keeping only the agents `alive` knows, and the orders with any left. */
export function orderFromStore(
  stored: Record<string, string[]> | undefined,
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
