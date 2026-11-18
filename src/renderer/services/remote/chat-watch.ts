/**
 * A chat another device of the account watches (chat.watch): its page
 * when the watch begins, then what changed since, as the tab's store
 * changes, at most UPDATES_PER_SECOND times a second. What changed is
 * found by the store's own objects: an item, call, task or subagent's
 * messages that is not the object sent last time is sent again. For a
 * watch that takes appends, an assistant item whose text only grew sends
 * the text it grew by instead.
 */

import type {
  ChatAppend,
  ChatPage,
  ChatPanel,
  ChatStatus,
  ChatStreamAppend,
  ChatUpdate,
  ViewAssistantItem,
  ViewItem,
  ViewStreaming,
} from "../../../../packages/remote-protocol/src";
import { MAX_READ_ITEMS } from "../../../../packages/remote-protocol/src";
import { profileOf } from "../../../shared/agent-profiles/profiles";
import { useAgentProfilesStore } from "../../state/stores/agent-profiles";
import { useTabsStore } from "../../state/stores/tabs";
import { codexHistoryAvailable, codexHistoryBusy } from "../chat/codex-history";
import type { CodexModel } from "../chat/codex-model";
import type { ToolCall } from "../chat/model";
import { planUsageKeyFor, usePlanUsageStore, watchPlanUsageAfar } from "../chat/plan-usage";
import { chatKey, useChatStore } from "../chat/store";
import { supportsControl } from "../chat/versions";
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
import { cliProfileName } from "./profile-name";

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

/**
 * The text an assistant item's blocks grew by from `was` to `now`, as
 * appends to the item at `index`; null when anything else changed (a
 * block came or went, or one's text is not the old text and more), so
 * the whole item goes.
 */
export function appendsOf(
  wasItem: ViewItem,
  nowItem: ViewItem,
  index: number,
): ChatAppend[] | null {
  if (wasItem.kind !== "assistant" || nowItem.kind !== "assistant") return null;
  // The union's item of a kind not known yet keeps TypeScript from narrowing.
  const was = wasItem as ViewAssistantItem;
  const now = nowItem as ViewAssistantItem;
  if (
    was.key !== now.key ||
    was.messageId !== now.messageId ||
    was.at !== now.at ||
    was.forkable !== now.forkable
  )
    return null;
  if (was.blocks.length !== now.blocks.length) return null;
  const appends: ChatAppend[] = [];
  for (const [block, after] of now.blocks.entries()) {
    const before = was.blocks[block];
    if (before?.type !== after.type) return null;
    if (after.type === "tool") {
      if (before.type !== "tool" || before.toolUseId !== after.toolUseId) return null;
      continue;
    }
    if (before.type === "tool") return null;
    if (after.text === before.text) continue;
    if (!after.text.startsWith(before.text)) return null;
    appends.push({ index, block, text: after.text.slice(before.text.length) });
  }
  return appends.length > 0 ? appends : null;
}

/**
 * The text the reply being written grew by, block by block (none when it
 * did not); null when it is another reply, or a block came, went or
 * changed other than by growing, so the whole message goes.
 */
export function streamAppendsOf(
  was: ViewStreaming | null,
  now: ViewStreaming | null,
): ChatStreamAppend[] | null {
  if (!was || !now || was.messageId !== now.messageId) return null;
  if (was.blocks.length !== now.blocks.length) return null;
  const appends: ChatStreamAppend[] = [];
  for (const [block, after] of now.blocks.entries()) {
    const before = was.blocks[block];
    if (before?.type !== after.type || before.toolUseId !== after.toolUseId) return null;
    if (after.text === before.text) continue;
    if (!after.text.startsWith(before.text)) return null;
    appends.push({ block, text: after.text.slice(before.text.length) });
  }
  return appends;
}

/**
 * The status to send, and what its reply being written grew by: for a
 * watch that takes appends, a reply that only grew comes as streamAppends,
 * and the status without it, only when the rest of it changed.
 */
function statusChange(
  was: string,
  now: string,
  appends: boolean,
): Pick<ChatChange, "status" | "streamAppends"> {
  if (now === was) return {};
  const after = JSON.parse(now) as ChatStatus;
  if (!appends) return { status: after };
  const before = JSON.parse(was) as ChatStatus;
  const grown = streamAppendsOf(before.streaming, after.streaming);
  if (!grown) return { status: after };
  const { streaming: _after, ...rest } = after;
  const { streaming: _before, ...restBefore } = before;
  return {
    ...(JSON.stringify(rest) !== JSON.stringify(restBefore) ? { status: rest } : {}),
    ...(grown.length > 0 ? { streamAppends: grown } : {}),
  };
}

/**
 * What changed from `was` to `now`; null when nothing did. With
 * `appends`, an assistant item whose text only grew comes as appends, and
 * so does the reply being written.
 */
export function changesOf(was: Sent, now: Sent, appends = false): ChatChange | null {
  const before = was.window;
  const after = now.window;
  const items: ChatChange["items"] = [];
  const grown: ChatAppend[] = [];
  for (const [i, item] of after.items.entries()) {
    const index = after.start + i;
    const old = index >= before.start ? before.items[index - before.start] : undefined;
    if (old === item) continue;
    const view = viewItemOf(item);
    const added = appends && old !== undefined ? appendsOf(viewItemOf(old), view, index) : null;
    if (added) grown.push(...added);
    else items.push({ index, item: view });
  }
  const tools: ChatChange["tools"] = {};
  for (const [id, tool] of after.tools) {
    if (before.tools.get(id) !== tool) tools[id] = viewToolOf(tool);
  }
  const tasks: ChatChange["tasks"] = {};
  let byId: Record<string, ToolCall> | undefined;
  for (const [id, task] of after.tasks) {
    if (before.tasks.get(id) === task) continue;
    byId ??= Object.fromEntries(after.tools);
    tasks[id] = viewTaskOf(task, byId);
  }
  const agentItems: ChatChange["agentItems"] = {};
  for (const [id, list] of after.agents) {
    if (before.agents.get(id) !== list) agentItems[id] = list.map(viewAssistantOf);
  }
  const { status, streamAppends } = statusChange(was.status, now.status, appends);
  const panel = now.panel !== was.panel ? JSON.parse(now.panel) : undefined;
  const cut = after.total !== before.total;
  if (
    !cut &&
    !status &&
    !panel &&
    items.length === 0 &&
    grown.length === 0 &&
    !streamAppends &&
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
    ...(grown.length > 0 ? { appends: grown } : {}),
    ...(streamAppends ? { streamAppends } : {}),
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
 * A check to run on each change: `act` once each time `can` comes true,
 * not again until it has gone false and come back.
 */
export function eachTimeItCan(can: () => boolean, act: () => void): () => void {
  let could = false;
  return () => {
    const now = can();
    if (now && !could) act();
    could = now;
  };
}

/**
 * Starts watching a chat for another device: its page now, then `push`
 * with each change, until stopChatWatch or the tab is gone (`onGone`);
 * a reply's growing text as appends when the watcher takes them.
 */
export function startChatWatch(
  watchId: string,
  sourceOf: SourceOf,
  limit: number | undefined,
  push: (change: ChatChange) => void,
  onGone: () => void,
  options: {
    appends?: boolean;
    /** Each time the tab changes, before what changed is sent. */
    onChange?: () => void;
    /** The plan usage's key of its profile, asked for while it is watched; null once it is gone. */
    usageKey?: () => string | null;
  } = {},
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
    const change = changesOf(sent, next, options.appends === true);
    sent = next;
    if (change) push(change);
  };
  const changed = () => {
    options.onChange?.();
    if (timer) return;
    const wait = Math.max(0, last + 1000 / UPDATES_PER_SECOND - Date.now());
    timer = setTimeout(flush, wait);
  };
  const offChat = useChatStore.subscribe(changed);
  const offTabs = useTabsStore.subscribe(changed);
  // The plan's usage comes apart from the chat: its limits in the panel follow it.
  const offPlan = usePlanUsageStore.subscribe(changed);
  // Shown on that device: its profile's usage is asked for as a tab shown here asks.
  const offAfar = options.usageKey ? watchPlanUsageAfar(watchId, options.usageKey) : () => {};
  const stop = () => {
    offChat();
    offTabs();
    offPlan();
    offAfar();
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
  const plan =
    usePlanUsageStore.getState().byKey[planUsageKeyFor(agent, workspaceId, tab.props.profileId)];
  const config = useAgentProfilesStore.getState().config;
  const moves = tab.props.moves?.map((move) => ({
    after: move.after,
    profile: cliProfileName(profileOf(config, agent, move.profileId)),
    at: move.at,
  }));
  const codex = chat.model as CodexModel;
  const codexIdle = Boolean(codex.threadId && !codexHistoryBusy(chat));
  return {
    agent,
    title: tab.title,
    chat,
    ...(tab.props.relayed ? { relayed: tab.props.relayed } : {}),
    ...(moves && moves.length > 0 ? { moves } : {}),
    ...(tab.type === "claude"
      ? {
          can: {
            rewind: true,
            // A fork copies a session: one the tab has, or the one it copies itself.
            fork: Boolean(chat.model.sessionId ?? tab.props.sessionId ?? tab.props.fork?.sessionId),
            background: true,
            now: true,
            withdraw: supportsControl(chat.version ?? chat.model.version, "cancel_async_message"),
            hurry: true,
            moveNow: true,
            mcp: true,
            config: true,
          },
        }
      : {
          can: {
            rewind:
              codexIdle &&
              codexHistoryAvailable(codex.appServerVersion ?? chat.version) &&
              codex.items.some((item) => item.kind === "user" && item.rewindable),
            fork: codexIdle && codex.items.length > 0,
            background: false,
            moveNow: true,
            config: true,
          },
        }),
    ...(plan?.claude || plan?.codex
      ? {
          plan: {
            ...(plan.claude ? { claude: plan.claude } : {}),
            ...(plan.codex ? { codex: plan.codex } : {}),
          },
        }
      : {}),
  };
}
