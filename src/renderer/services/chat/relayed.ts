// Messages another agent sent a tab through the nexus command show as
// received from it, not as the user's: found by the records the tab keeps
// of them (the message's id, or a Codex message's turn), not by what the
// text says, so text the user writes that looks the same stays theirs.

import { RELAY_MARK, type RelayedMessage, withoutRelayHeader } from "../../../shared/chat/relay";
import type { ChatItem, MessageSource, UserItem } from "./model";

/** The record of a message, by its ids; a Codex one a resumed thread renumbered, by its turn. */
function recordFinder(
  records: readonly RelayedMessage[],
): (item: UserItem) => RelayedMessage | undefined {
  const byId = new Map(records.map((r) => [r.id, r]));
  const byTurn = new Map<string, RelayedMessage[]>();
  for (const r of [...records].sort((a, b) => a.at - b.at)) {
    if (r.turnId) byTurn.set(r.turnId, [...(byTurn.get(r.turnId) ?? []), r]);
  }
  // A turn steered more than once holds more than one: the first record the first.
  const used = new Map<string, number>();
  return (item) => {
    const direct =
      (item.uuid !== undefined ? byId.get(item.uuid) : undefined) ??
      (item.sentUuid !== undefined ? byId.get(item.sentUuid) : undefined) ??
      (item.key.startsWith("u-") ? byId.get(item.key.slice(2)) : undefined);
    if (direct) return direct;
    if (!item.turnId || !item.text.startsWith(RELAY_MARK)) return undefined;
    const list = byTurn.get(item.turnId);
    const n = used.get(item.turnId) ?? 0;
    if (!list || n >= list.length) return undefined;
    used.set(item.turnId, n + 1);
    return list[n];
  };
}

/** Who sent a message through the nexus command, as a received message names it. */
export function relaySource(from: RelayedMessage["from"]) {
  const { kind, agent, name, workspaceId, tabId, device, hops } = from;
  const source: MessageSource = { kind };
  if (name) source.name = name;
  if (agent) source.agent = agent;
  if (workspaceId) source.workspaceId = workspaceId;
  if (tabId) source.tabId = tabId;
  if (device) source.device = { id: device.id, name: device.name };
  if (hops !== undefined) source.hops = hops;
  return source;
}

/**
 * A conversation's items as the tab shows them: each message another agent
 * sent it through the nexus command is one received from that agent,
 * without the line that told the agent who sent it. One still waiting for
 * the agent to read it stays where it waits, without the line too. The
 * same items when the records name none.
 */
export function withRelayed(
  items: ChatItem[],
  records: readonly RelayedMessage[] | undefined,
): ChatItem[] {
  if (!records || records.length === 0) return items;
  const find = recordFinder(records);
  let changed = false;
  const shown = items.map((item): ChatItem => {
    if (item.kind !== "user") return item;
    const record = find(item);
    if (!record) return item;
    changed = true;
    // The same item for the same message, so the list does not render it again.
    const was = received.get(item);
    if (was?.record === record) return was.shown;
    const now = asReceived(item, record);
    received.set(item, { record, shown: now });
    return now;
  });
  return changed ? shown : items;
}

/** Each message shown as received, by the item it was and the record that found it. */
const received = new WeakMap<UserItem, { record: RelayedMessage; shown: ChatItem }>();

function asReceived(item: UserItem, record: RelayedMessage): ChatItem {
  const text = withoutRelayHeader(item.text);
  // Waiting for the agent to read it (isWaiting): it stays where it waits.
  if (item.state === "sent" && item.queued === true) return { ...item, text };
  return {
    kind: "received",
    key: item.key,
    ...(item.uuid ? { uuid: item.uuid } : {}),
    from: relaySource(record.from),
    text,
    ...(item.at !== undefined ? { at: item.at } : {}),
  };
}

/**
 * How many messages between agents led to the message that started the
 * conversation's latest turn: what another agent sent (its hops; 1 for one
 * from before they were counted), or 0 for the user's. A message still
 * waiting to be read started nothing yet.
 */
export function turnHopsOf(items: readonly ChatItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === "received") {
      return item.from.hops ?? (RELAY_KINDS.has(item.from.kind) ? 1 : 0);
    }
    if (item?.kind === "user" && !(item.state === "sent" && item.queued === true)) return 0;
  }
  return 0;
}

/** The senders of messages sent through the nexus command, as MessageSource kinds. */
export const RELAY_KINDS: ReadonlySet<string> = new Set(["tab", "terminal", "manager"]);

/**
 * Who sent a message through the nexus command, in words, for text that
 * tells the conversation (chat read, /export): `tab "NAME"`, `Codex in
 * terminal "NAME"`, `the manager`. Undefined for other senders.
 */
export function relaySenderText(from: MessageSource): string | undefined {
  if (!RELAY_KINDS.has(from.kind)) return undefined;
  const on = from.device ? ` on ${JSON.stringify(from.device.name)}` : "";
  if (from.kind === "manager") return `the manager${on}`;
  const name = from.name ? ` ${JSON.stringify(from.name)}` : "";
  if (from.kind === "tab") return `tab${name}${on}`;
  return `${from.agent === "codex" ? "Codex" : "Claude Code"} in terminal${name}${on}`;
}
