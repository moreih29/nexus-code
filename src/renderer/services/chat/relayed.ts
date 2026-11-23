import {
  type AppMessage,
  RELAY_MARK,
  type RelayedMessage,
  withoutRelayHeader,
} from "../../../shared/chat/relay";
import type { ChatItem, MessageSource, UserItem } from "./model";

function recordFinder(
  records: readonly RelayedMessage[],
): (item: UserItem) => RelayedMessage | undefined {
  const byId = new Map(records.map((r) => [r.id, r]));
  const byTurn = new Map<string, RelayedMessage[]>();
  for (const r of [...records].sort((a, b) => a.at - b.at)) {
    if (r.turnId) byTurn.set(r.turnId, [...(byTurn.get(r.turnId) ?? []), r]);
  }
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

export function relaySource(from: RelayedMessage["from"]) {
  const { kind, agent, name, workspaceId, tabId, device } = from;
  const source: MessageSource = { kind };
  if (name) source.name = name;
  if (agent) source.agent = agent;
  if (workspaceId) source.workspaceId = workspaceId;
  if (tabId) source.tabId = tabId;
  if (device) source.device = { id: device.id, name: device.name };
  return source;
}

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
    const was = received.get(item);
    if (was?.record === record) return was.shown;
    const now = asReceived(item, record);
    received.set(item, { record, shown: now });
    return now;
  });
  return changed ? shown : items;
}

const received = new WeakMap<UserItem, { record: RelayedMessage; shown: ChatItem }>();

function asReceived(item: UserItem, record: RelayedMessage): ChatItem {
  const text = withoutRelayHeader(item.text);
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

const appRecords = new WeakMap<AppMessage, RelayedMessage>();
const joined = new WeakMap<
  readonly AppMessage[],
  { relayed?: readonly RelayedMessage[]; all: RelayedMessage[] }
>();

export function relayedOf(props: {
  relayed?: readonly RelayedMessage[];
  fromApp?: readonly AppMessage[];
}): readonly RelayedMessage[] | undefined {
  const { relayed, fromApp } = props;
  if (!fromApp || fromApp.length === 0) return relayed;
  const was = joined.get(fromApp);
  if (was && was.relayed === relayed) return was.all;
  const app = fromApp.map((message) => {
    let record = appRecords.get(message);
    if (!record) {
      record = { ...message, from: { kind: "app" } };
      appRecords.set(message, record);
    }
    return record;
  });
  const all = [...(relayed ?? []), ...app];
  joined.set(fromApp, { ...(relayed ? { relayed } : {}), all });
  return all;
}

export const RELAY_KINDS: ReadonlySet<string> = new Set(["tab", "terminal", "manager", "app"]);

export function relaySenderText(from: MessageSource): string | undefined {
  if (!RELAY_KINDS.has(from.kind)) return undefined;
  const on = from.device ? ` on ${JSON.stringify(from.device.name)}` : "";
  if (from.kind === "manager") return `the manager${on}`;
  if (from.kind === "app") return "NexusCode (the app)";
  const name = from.name ? ` ${JSON.stringify(from.name)}` : "";
  if (from.kind === "tab") return `tab${name}${on}`;
  return `${from.agent === "codex" ? "Codex" : "Claude Code"} in terminal${name}${on}`;
}
