import type { RoomPeer } from "../../../shared/remote/room";

export type AgentOrder = Readonly<Record<string, readonly string[]>>;

export const NO_ORDER: AgentOrder = {};

export type DropEdge = "before" | "after";

export function orderSessions<T extends { readonly key: string }>(
  sessions: readonly T[],
  order: readonly string[] | undefined,
): readonly T[] {
  return orderRows(sessions, order, (session) => session.key);
}

type OrderedPeer = Pick<RoomPeer, "id" | "name" | "online">;

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
  return ordered.every((row, i) => row === rows[i]) ? rows : ordered;
}

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

export function orderToStore(order: AgentOrder): Record<string, string[]> {
  return Object.fromEntries(Object.entries(order).map(([id, keys]) => [id, [...keys]]));
}
