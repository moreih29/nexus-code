/**
 * A chat another device of the account watches (chat.watch): its page
 * when the watch begins, then what changed since, as the tab's store
 * changes, at most UPDATES_PER_SECOND times a second. What changed is
 * found by the store's own objects: an item, call, task or subagent's
 * messages that is not the object sent last time is sent again.
 */

import type { ChatPage, ChatPanel, ChatUpdate } from "../../../../packages/remote-protocol/src";
import { MAX_READ_ITEMS } from "../../../../packages/remote-protocol/src";
import { useTabsStore } from "../../state/stores/tabs";
import { chatKey, useChatStore } from "../chat/store";
import {
  type ChatSource,
  type ChatWindow,
  chatPageOf,
  chatStatusOf,
  chatWindowOf,
  conversationOf,
  DEFAULT_READ_ITEMS,
  viewAssistantOf,
  viewItemOf,
  viewTaskOf,
  viewToolOf,
} from "./chat-page";
import { chatPanelOf } from "./chat-panel";

/** What a watch sends: an update but for its id and rev, which main gives it. */
export type ChatChange = Omit<ChatUpdate, "watchId" | "rev">;

/** How often a watched chat's changes are sent at most: a reply streams in at this pace. */
export const UPDATES_PER_SECOND = 15;

/** What a watch sent last: the window, by the store's objects, and the status and panel as sent. */
export interface Sent {
  window: ChatWindow;
  status: string;
  panel: string;
}

export function sentOf(source: ChatSource, start: number): Sent {
  return {
    window: chatWindowOf(source, start),
    status: JSON.stringify(chatStatusOf(source)),
    panel: JSON.stringify(chatPanelOf(source)),
  };
}

/**
 * Where the window starts now: where it did, unless the conversation got
 * shorter than that (cleared, rewound), when it starts `limit` from the end.
 */
export function windowStart(was: number, total: number, limit: number): number {
  return total < was ? Math.max(0, total - limit) : was;
}

/** What changed from `was` to `now`; null when nothing did. */
export function changesOf(was: Sent, now: Sent): ChatChange | null {
  const before = was.window;
  const after = now.window;
  const items: ChatChange["items"] = [];
  for (const [i, item] of after.items.entries()) {
    const index = after.start + i;
    const old = index >= before.start ? before.items[index - before.start] : undefined;
    if (old !== item) items.push({ index, item: viewItemOf(item) });
  }
  const tools: ChatChange["tools"] = {};
  for (const [id, tool] of after.tools) {
    if (before.tools.get(id) !== tool) tools[id] = viewToolOf(tool);
  }
  const tasks: ChatChange["tasks"] = {};
  for (const [id, task] of after.tasks) {
    if (before.tasks.get(id) !== task) tasks[id] = viewTaskOf(task);
  }
  const agentItems: ChatChange["agentItems"] = {};
  for (const [id, list] of after.agents) {
    if (before.agents.get(id) !== list) agentItems[id] = list.map(viewAssistantOf);
  }
  const status = now.status !== was.status ? JSON.parse(now.status) : undefined;
  const panel = now.panel !== was.panel ? JSON.parse(now.panel) : undefined;
  const cut = after.total !== before.total;
  if (
    !cut &&
    !status &&
    !panel &&
    items.length === 0 &&
    Object.keys(tools).length === 0 &&
    Object.keys(tasks).length === 0 &&
    Object.keys(agentItems).length === 0
  ) {
    return null;
  }
  return {
    ...(status ? { status } : {}),
    total: after.total,
    items,
    tools,
    tasks,
    agentItems,
    ...(panel ? { panel } : {}),
  };
}

// ---------------------------------------------------------------------------
// The watches of this window
// ---------------------------------------------------------------------------

interface Watch {
  stop(): void;
}

const watches = new Map<string, Watch>();

/** The tab's conversation as a watch reads it; null once the tab is gone. */
type SourceOf = () => ChatSource | null;

/**
 * Starts watching a chat for another device: its page now, then `push`
 * with each change, until stopChatWatch or the tab is gone (`onGone`).
 */
export function startChatWatch(
  watchId: string,
  sourceOf: SourceOf,
  limit: number | undefined,
  push: (change: ChatChange) => void,
  onGone: () => void,
): ChatPage & { panel: ChatPanel } {
  stopChatWatch(watchId);
  const source = sourceOf();
  if (!source) throw new Error("that tab is gone");
  const count = Math.min(limit ?? DEFAULT_READ_ITEMS, MAX_READ_ITEMS);
  const page = chatPageOf(source, { limit: count });
  let sent = sentOf(source, page.start);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = 0;

  const flush = () => {
    timer = null;
    last = Date.now();
    const now = sourceOf();
    if (!now) {
      stop();
      onGone();
      return;
    }
    const total = conversationOf(now).items.length;
    const next = sentOf(now, windowStart(sent.window.start, total, count));
    const change = changesOf(sent, next);
    sent = next;
    if (change) push(change);
  };
  const changed = () => {
    if (timer) return;
    const wait = Math.max(0, last + 1000 / UPDATES_PER_SECOND - Date.now());
    timer = setTimeout(flush, wait);
  };
  const offChat = useChatStore.subscribe(changed);
  const offTabs = useTabsStore.subscribe(changed);
  const stop = () => {
    offChat();
    offTabs();
    if (timer) clearTimeout(timer);
    watches.delete(watchId);
  };
  watches.set(watchId, { stop });
  return { ...page, panel: JSON.parse(sent.panel) };
}

export function stopChatWatch(watchId: string): void {
  watches.get(watchId)?.stop();
}

/** How many chats other devices watch here now. */
export function watchCount(): number {
  return watches.size;
}

/** A chat tab's conversation as a watch reads it, by its ids; null once it is gone. */
export function tabSource(
  workspaceId: string,
  tabId: string,
  agent: ChatSource["agent"],
): ChatSource | null {
  const chat = useChatStore.getState().tabs[chatKey(workspaceId, tabId)];
  const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
  if (!chat || !tab || (tab.type !== "claude" && tab.type !== "codex")) return null;
  return {
    agent,
    title: tab.title,
    chat,
    ...(tab.props.relayed ? { relayed: tab.props.relayed } : {}),
  };
}
