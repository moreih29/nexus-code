/**
 * The order the user drags the agent view's list into: for each workspace
 * (or task), the session keys of its agents. Agents it does not name, a new
 * one or one from before any drag, come after those it does, as they come.
 * Pure.
 */

/** The orders by workspace id. */
export type AgentOrder = Readonly<Record<string, readonly string[]>>;

export const NO_ORDER: AgentOrder = {};

/** `sessions` in `order`: those it names first, as it names them, then the rest. */
export function orderSessions<T extends { readonly key: string }>(
  sessions: readonly T[],
  order: readonly string[] | undefined,
): readonly T[] {
  if (!order || order.length === 0 || sessions.length < 2) return sessions;
  const rank = new Map(order.map((key, i) => [key, i]));
  const listed = sessions
    .filter((session) => rank.has(session.key))
    .sort((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0));
  const ordered = [...listed, ...sessions.filter((session) => !rank.has(session.key))];
  // The same array while nothing moved, so what is built from it is kept.
  return ordered.every((session, i) => session === sessions[i]) ? sessions : ordered;
}

/** `keys` with `moved` put just before or after `target`; as they were when either is missing. */
export function moveKey(
  keys: readonly string[],
  moved: string,
  target: string,
  edge: "before" | "after",
): string[] {
  if (moved === target || !keys.includes(moved)) return [...keys];
  const rest = keys.filter((key) => key !== moved);
  const at = rest.indexOf(target);
  if (at < 0) return [...keys];
  rest.splice(edge === "before" ? at : at + 1, 0, moved);
  return rest;
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
