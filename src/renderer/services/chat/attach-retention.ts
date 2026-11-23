// How long the files attached to chat messages stay (internal/chat/
// attach_retain.go). The agent keeps them after their tab closes: the
// conversation goes on in another tab, after /resume, from the history or
// in a fork, and its messages name them by path. What keeps one is use:
// - while a tab is open, its own folder's files and the files its
//   conversation names stay, and each prune marks them used. What the
//   conversation names is kept with the tab (its props' `attachments`),
//   for a tab not yet read since the app started;
// - a file a conversation names is marked used as it is shown or sent;
// - a prune removes the rest unused for 30 days, and the least recently
//   used past 1 GiB (main tells the agent the numbers);
// - deleting a conversation removes the files it names that no open tab
//   uses; removing a workspace removes its folder (main).
// A file is one the agent wrote only right in a slot of the workspace's
// attach folder (attachSlotOf): a mention elsewhere is not touched.

import { createLogger } from "../../../shared/log/renderer";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import { type ClaudeTab, type CodexTab, useTabsStore } from "../../state/stores/tabs";
import { registerWorkspaceCleanup } from "../../state/workspace-cleanup";
import { attachRootOf, attachSlotOf } from "./attach-folders";
import type { ChatItem, ChatModel } from "./model";
import { attachedFilesOf } from "./panel";
import { chatKey, useChatStore } from "./store";

const log = createLogger("attach-retention");

/** How often an app left running prunes a workspace's attached files again. */
export const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
/** How long the chats settle before what they name is looked at again. */
const SETTLE_MS = 1_000;
/** How long the root an agent told is taken as known. */
const ROOT_KNOWN_MS = 60_000;
/** When a prune waits for the agent to tell its root, how long it waits between asks, and how many. */
const ROOT_RETRY_MS = 30_000;
const ROOT_TRIES = 10;
/** Most slots a tab keeps: the newest stay. */
const MAX_TAB_SLOTS = 500;
/** Most slots one call names (the agent's own limit). */
const MAX_CALL_SLOTS = 5_000;

type ChatTab = ClaudeTab | CodexTab;

function chatTabsOf(workspaceId: string): ChatTab[] {
  return Object.values(useTabsStore.getState().byWorkspace[workspaceId] ?? {}).filter(
    (tab): tab is ChatTab => tab.type === "claude" || tab.type === "codex",
  );
}

const roots = new Map<string, { at: number; root: Promise<string | null> }>();

/** The workspace's attach root (attachRootOf), asked again a while after, or after none. */
function rootOf(workspaceId: string): Promise<string | null> {
  const known = roots.get(workspaceId);
  if (known && Date.now() - known.at < ROOT_KNOWN_MS) return known.root;
  const root = attachRootOf(workspaceId).then((found) => {
    if (found === null && roots.get(workspaceId)?.root === root) roots.delete(workspaceId);
    return found;
  });
  roots.set(workspaceId, { at: Date.now(), root });
  return root;
}

const filesByItem = new WeakMap<ChatItem, string[]>();

/** The files the user attached to a conversation's messages (attachedFilesOf), each once. */
export function attachedFilesIn(items: readonly ChatItem[], cwd: string): string[] {
  const files = new Set<string>();
  for (const item of items) {
    if (item.kind !== "user") continue;
    let named = filesByItem.get(item);
    if (!named) {
      named = attachedFilesOf(item, cwd);
      filesByItem.set(item, named);
    }
    for (const file of named) files.add(file);
  }
  return [...files];
}

/** The slots ("<tabId>/<n>") of those of `files` the agent wrote under `root`, each once. */
export function slotsOf(files: Iterable<string>, root: string, workspaceId: string): string[] {
  const slots = new Set<string>();
  for (const file of files) {
    const slot = attachSlotOf(root, workspaceId, file);
    if (slot) slots.add(slot);
  }
  return [...slots];
}

/** A chat tab's conversation as the app holds it: its session or thread ("" before it has one) and items. */
function conversationOf(
  workspaceId: string,
  tab: ChatTab,
): { key: string; items: ChatItem[]; history: unknown; live: unknown } | null {
  const chat = useChatStore.getState().tabs[chatKey(workspaceId, tab.id)];
  if (!chat) return null;
  const model = chat.model as ChatModel & { threadId?: string };
  const items = chat.history ? [...chat.history.items, ...model.items] : model.items;
  const key =
    tab.type === "claude"
      ? (model.sessionId ?? tab.props.sessionId ?? tab.props.fork?.sessionId ?? "")
      : (model.threadId ?? tab.props.threadId ?? tab.props.fork?.threadId ?? "");
  return { key, items, history: chat.history?.items, live: model.items };
}

/** The slots the open chat tabs' conversations name: those they keep and those read now. */
function keptSlots(workspaceId: string, tabs: readonly ChatTab[], root: string): string[] {
  const slots = new Set<string>();
  for (const tab of tabs) {
    for (const slot of tab.props.attachments?.slots ?? []) slots.add(slot);
    const conversation = conversationOf(workspaceId, tab);
    if (!conversation) continue;
    for (const slot of slotsOf(
      attachedFilesIn(conversation.items, tab.props.cwd),
      root,
      workspaceId,
    ))
      slots.add(slot);
  }
  return [...slots].slice(-MAX_CALL_SLOTS);
}

/** What each tab's conversation was when last looked at, so an unchanged one is not again. */
const looked = new Map<string, { key: string; history: unknown; live: unknown }>();
/** The slots marked used since the app started, by workspace: shown again, not marked again. */
const touched = new Map<string, Set<string>>();

/**
 * Keeps with the tab what its conversation names, and marks used what it
 * names that was not yet since the app started: the conversation is shown
 * or sent to.
 */
async function followTab(workspaceId: string, tab: ChatTab, root: string): Promise<void> {
  const conversation = conversationOf(workspaceId, tab);
  if (!conversation) return;
  const at = chatKey(workspaceId, tab.id);
  const was = looked.get(at);
  if (
    was?.key === conversation.key &&
    was.history === conversation.history &&
    was.live === conversation.live
  )
    return;
  looked.set(at, {
    key: conversation.key,
    history: conversation.history,
    live: conversation.live,
  });
  const slots = slotsOf(attachedFilesIn(conversation.items, tab.props.cwd), root, workspaceId);
  // Nothing named, or nothing read yet: what the tab keeps stays.
  if (slots.length === 0) return;
  const saved = tab.props.attachments;
  const same = saved?.conversation === conversation.key;
  const next = same ? [...new Set([...saved.slots, ...slots])] : slots;
  if (!same || next.length !== saved.slots.length) {
    useTabsStore.getState().setChatAttachments(workspaceId, tab.id, {
      conversation: conversation.key,
      slots: next.slice(-MAX_TAB_SLOTS),
    });
  }
  const done = touched.get(workspaceId) ?? new Set<string>();
  touched.set(workspaceId, done);
  const fresh = slots.filter((slot) => !done.has(slot));
  if (fresh.length === 0) return;
  for (const slot of fresh) done.add(slot);
  await touchAttachments(workspaceId, fresh).catch((error: Error) => {
    for (const slot of fresh) done.delete(slot);
    log.warn(`marking attachments used failed: ${error.message}`);
  });
}

async function touchAttachments(workspaceId: string, slots: string[]): Promise<void> {
  for (let i = 0; i < slots.length; i += MAX_CALL_SLOTS) {
    unwrapIpcResult(
      await ipcCallResult("chat", "touchAttachments", {
        workspaceId,
        slots: slots.slice(i, i + MAX_CALL_SLOTS),
      }),
    );
  }
}

/** Workspaces whose chats are followed, and pruned now and then. */
const followed = new Set<string>();
let unsubscribe: (() => void) | undefined;
let settle: ReturnType<typeof setTimeout> | undefined;
let pruneTimer: ReturnType<typeof setInterval> | undefined;

async function followAll(): Promise<void> {
  for (const workspaceId of followed) {
    const root = await rootOf(workspaceId);
    if (!root) continue;
    for (const tab of chatTabsOf(workspaceId)) await followTab(workspaceId, tab, root);
  }
}

function follow(workspaceId: string): void {
  followed.add(workspaceId);
  unsubscribe ??= useChatStore.subscribe((state, prev) => {
    if (state.tabs === prev.tabs || settle) return;
    settle = setTimeout(() => {
      settle = undefined;
      void followAll().catch((error: Error) => log.warn(`following attachments: ${error.message}`));
    }, SETTLE_MS);
  });
  pruneTimer ??= setInterval(() => {
    for (const id of followed) void pruneAttachments(id);
  }, PRUNE_EVERY_MS);
}

registerWorkspaceCleanup((workspaceId) => {
  followed.delete(workspaceId);
  roots.delete(workspaceId);
  touched.delete(workspaceId);
  waiting.delete(workspaceId);
  const prefix = `${workspaceId}:`;
  for (const key of looked.keys()) if (key.startsWith(prefix)) looked.delete(key);
});

/**
 * Prunes the workspace's attached files (chat.pruneAttachments): the open
 * chat tabs' and what their conversations name stay; with `capOnly`, only
 * the room is made. Done only once the agent tells its attach root, so a
 * file an open conversation names is never taken for an unused one; false
 * while it tells none.
 */
export async function pruneAttachments(workspaceId: string, capOnly = false): Promise<boolean> {
  const root = await rootOf(workspaceId);
  if (!root) return false;
  const tabs = chatTabsOf(workspaceId);
  unwrapIpcResult(
    await ipcCallResult("chat", "pruneAttachments", {
      workspaceId,
      keepTabIds: tabs.map((tab) => tab.id),
      keepSlots: keptSlots(workspaceId, tabs, root),
      ...(capOnly ? { capOnly: true } : {}),
    }),
  );
  return true;
}

/** Workspaces whose first prune waits for the agent to tell its root. */
const waiting = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Starts following the workspace's chats, once while the app runs, and
 * prunes its attached files: now, or as soon as its agent is up, then each
 * PRUNE_EVERY_MS.
 */
export function pruneAttachmentsOnce(workspaceId: string): void {
  if (followed.has(workspaceId)) return;
  follow(workspaceId);
  let tries = 0;
  const attempt = () => {
    waiting.delete(workspaceId);
    if (!followed.has(workspaceId)) return;
    void pruneAttachments(workspaceId).then(
      (done) => {
        if (done || ++tries >= ROOT_TRIES) return;
        waiting.set(workspaceId, setTimeout(attempt, ROOT_RETRY_MS));
      },
      (error: Error) => log.warn(`pruning attachments failed: ${error.message}`),
    );
  };
  attempt();
}

/** After a file is attached: the room is made, the rest left to the next prune. */
export function pruneAttachmentsAfterAttach(workspaceId: string): void {
  void pruneAttachments(workspaceId, true).catch((error: Error) =>
    log.warn(`making room for attachments failed: ${error.message}`),
  );
}

/** For tests: looks at the followed chats now, not once they settle. */
export function followAttachmentsNow(): Promise<void> {
  return followAll();
}

/** For tests: forgets what was followed. */
export function resetAttachmentRetention(): void {
  unsubscribe?.();
  unsubscribe = undefined;
  if (settle) clearTimeout(settle);
  settle = undefined;
  if (pruneTimer) clearInterval(pruneTimer);
  pruneTimer = undefined;
  for (const timer of waiting.values()) clearTimeout(timer);
  waiting.clear();
  followed.clear();
  roots.clear();
  touched.clear();
  looked.clear();
}
