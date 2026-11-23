// How long the files attached to chat messages stay (internal/chat/
// attach_retain.go). The agent keeps them after their tab closes: the
// conversation goes on in another tab, after /resume, from the history or
// in a fork, and its messages name them by path. What keeps one is use:
// - while a tab is open, its own folder's files and the files its
//   conversation names stay, and each prune marks them used. What the
//   conversation names is kept with the tab (its props' `attachments`),
//   for a tab not yet read since the app started. A tab loads a long
//   history a page at a time from its end: what the whole history names
//   is asked of the agent once a run (chat.historySlots, historyOf);
// - a file a conversation names is marked used as it is shown or sent,
//   and as its tab closes;
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
/** How long a history that could not be read is not asked for again. */
export const HISTORY_RETRY_MS = 60_000;
/** Most slots a tab keeps: the newest stay. */
const MAX_TAB_SLOTS = 500;
/** Most slots one call names, or one history tells (the agent's own limit). */
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

/**
 * The slots the open chat tabs' conversations name: those they keep, those
 * read now, and those their whole histories name (readOpenHistories).
 * Null while a history's are not known: nothing is to go on a guess. All
 * of them, however many: one left out would look unused.
 */
function keptSlots(
  workspaceId: string,
  tabs: readonly ChatTab[],
  root: string,
): Set<string> | null {
  const slots = new Set<string>();
  for (const tab of tabs) {
    const history = askedHistorySlots(workspaceId, tab);
    if (!history) return null;
    for (const slot of history) slots.add(slot);
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
  return slots;
}

/** A conversation's history as the agent keeps it, in a profile. */
interface History {
  agent: "claude" | "codex";
  conversation: string;
  profileId?: string;
}

/**
 * The histories a tab's slots are read from: its conversation's (from the
 * chat when read, else as the tab keeps it), and the one it was forked
 * from until the copy has its own, in the profile that keeps that.
 */
function historiesOf(workspaceId: string, tab: ChatTab): History[] {
  const agent = tab.type;
  const own = conversationOf(workspaceId, tab)?.key ?? "";
  const kept = tab.type === "claude" ? tab.props.sessionId : tab.props.threadId;
  const fork = tab.type === "claude" ? tab.props.fork?.sessionId : tab.props.fork?.threadId;
  const profileId = tab.props.profileId;
  const histories: History[] = [];
  for (const [conversation, profile] of [
    [own || kept, profileId],
    [fork, tab.props.fork?.profileId ?? profileId],
  ] as const) {
    if (!conversation || conversation.length > 128) continue;
    if (histories.some((history) => history.conversation === conversation)) continue;
    histories.push({ agent, conversation, ...(profile ? { profileId: profile } : {}) });
  }
  return histories;
}

const historyKey = (workspaceId: string, history: History) =>
  `${workspaceId}\n${history.agent}\n${history.profileId ?? ""}\n${history.conversation}`;

/** The slots each history named when asked this run (historyKey). */
const historySlots = new Map<string, readonly string[]>();
/** The histories that could not be read, and when: asked again HISTORY_RETRY_MS on. */
const historyFailed = new Map<string, { at: number; error: unknown }>();
/** The histories the agent had no file of yet when last asked, and when. */
const historyAbsent = new Map<string, number>();
/** The histories being asked. */
const askingHistory = new Map<string, Promise<readonly string[]>>();

/**
 * The slots a history names (chat.historySlots), asked once a run. One
 * that cannot be read (its file's rights, say, or more slots named than
 * the agent tells) fails the same for
 * HISTORY_RETRY_MS, unasked: a chat is looked at each second it streams.
 * One the agent has no file of yet (a fork's own, just named) names none
 * for as long, then is asked again; with `again`, now.
 */
function historyOf(
  workspaceId: string,
  history: History,
  again = false,
): Promise<readonly string[]> {
  const key = historyKey(workspaceId, history);
  const known = historySlots.get(key);
  if (known) return Promise.resolve(known);
  const failed = historyFailed.get(key);
  if (failed && Date.now() - failed.at < HISTORY_RETRY_MS) return Promise.reject(failed.error);
  const absent = historyAbsent.get(key);
  if (absent !== undefined && !again && Date.now() - absent < HISTORY_RETRY_MS) {
    return Promise.resolve([]);
  }
  const asking = askingHistory.get(key);
  if (asking) return asking;
  const asked = ipcCallResult("chat", "historySlots", { workspaceId, ...history })
    .then((result) => {
      const { slots, found, truncated } = unwrapIpcResult(result);
      // Those left out are not known: as one not read.
      if (truncated) throw new Error("a history names more attachments than can be told");
      historyFailed.delete(key);
      if (found) {
        historySlots.set(key, slots);
        historyAbsent.delete(key);
      } else {
        historyAbsent.set(key, Date.now());
      }
      return slots;
    })
    .catch((error: unknown) => {
      historyFailed.set(key, { at: Date.now(), error });
      log.warn(
        `reading a conversation's attachments: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    })
    .finally(() => askingHistory.delete(key));
  askingHistory.set(key, asked);
  return asked;
}

/** The slots the tab's histories name (historiesOf), as asked. */
async function historySlotsOf(workspaceId: string, tab: ChatTab, again = false): Promise<string[]> {
  const named = await Promise.all(
    historiesOf(workspaceId, tab).map((history) => historyOf(workspaceId, history, again)),
  );
  return [...new Set(named.flat())];
}

/**
 * Asks what the open chat tabs' whole histories name, for those not yet
 * asked or without a file when they were: before a prune or a deletion
 * names what stays. False when one could not be told.
 */
export async function readOpenHistories(workspaceId: string): Promise<boolean> {
  const asked = await Promise.allSettled(
    chatTabsOf(workspaceId).map((tab) => historySlotsOf(workspaceId, tab, true)),
  );
  return asked.every((result) => result.status === "fulfilled");
}

/** The slots the tab's histories named as already asked; null when one is not. */
function askedHistorySlots(workspaceId: string, tab: ChatTab): string[] | null {
  const slots: string[] = [];
  for (const history of historiesOf(workspaceId, tab)) {
    const key = historyKey(workspaceId, history);
    // One with no file yet names none.
    const named = historySlots.get(key) ?? (historyAbsent.has(key) ? [] : undefined);
    if (!named) return null;
    slots.push(...named);
  }
  return slots;
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
  const loaded = slotsOf(attachedFilesIn(conversation.items, tab.props.cwd), root, workspaceId);
  // What the history named before the pages the tab loaded. Unread, a
  // prune asks again (historyOf), and keeps and marks used what it names.
  const early = await historySlotsOf(workspaceId, tab).catch(() => []);
  const slots = [...new Set([...early, ...loaded])];
  // Nothing named, or nothing read yet: what the tab keeps stays.
  if (slots.length === 0) return;
  // What the tab kept under another name stays too: a fork takes its own
  // name before the agent has a history of it to tell these from.
  const saved = tab.props.attachments;
  const next = [...new Set([...(saved?.slots ?? []), ...slots])];
  if (saved?.conversation !== conversation.key || next.length !== saved.slots.length) {
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

/**
 * Touches or removes slots MAX_CALL_SLOTS a call. A call that fails stops
 * none after it; the first failure is thrown once all have gone.
 */
async function slotCalls(
  method: "touchAttachments" | "removeAttachments",
  workspaceId: string,
  slots: string[],
): Promise<void> {
  let failed: unknown;
  for (let i = 0; i < slots.length; i += MAX_CALL_SLOTS) {
    try {
      unwrapIpcResult(
        await ipcCallResult("chat", method, {
          workspaceId,
          slots: slots.slice(i, i + MAX_CALL_SLOTS),
        }),
      );
    } catch (error) {
      failed ??= error;
    }
  }
  if (failed !== undefined) throw failed;
}

function touchAttachments(workspaceId: string, slots: string[]): Promise<void> {
  return slotCalls("touchAttachments", workspaceId, slots);
}

/**
 * As a chat tab closes, marks used what its conversation names, though it
 * was marked once since the app started: the files' unused days start at
 * its last use, not at the app's start.
 */
async function touchClosed(workspaceId: string, tab: ChatTab): Promise<void> {
  const at = chatKey(workspaceId, tab.id);
  looked.delete(at);
  const root = await rootOf(workspaceId);
  if (!root) return;
  const slots = new Set(tab.props.attachments?.slots ?? []);
  for (const slot of askedHistorySlots(workspaceId, tab) ?? []) slots.add(slot);
  const conversation = conversationOf(workspaceId, tab);
  if (conversation) {
    for (const slot of slotsOf(
      attachedFilesIn(conversation.items, tab.props.cwd),
      root,
      workspaceId,
    ))
      slots.add(slot);
  }
  if (slots.size > 0) await touchAttachments(workspaceId, [...slots]);
}

/** Workspaces whose chats are followed, and pruned now and then. */
const followed = new Set<string>();
let unsubscribe: (() => void) | undefined;
let unsubscribeTabs: (() => void) | undefined;
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
  unsubscribeTabs ??= useTabsStore.subscribe((state, prev) => {
    if (state.byWorkspace === prev.byWorkspace) return;
    for (const id of followed) {
      const now = state.byWorkspace[id];
      const was = prev.byWorkspace[id];
      // A removed workspace's files go with its folder.
      if (!now || !was || now === was) continue;
      for (const [tabId, tab] of Object.entries(was)) {
        if (now[tabId] || (tab.type !== "claude" && tab.type !== "codex")) continue;
        void touchClosed(id, tab).catch((error: Error) =>
          log.warn(`marking a closed tab's attachments used failed: ${error.message}`),
        );
      }
    }
  });
  pruneTimer ??= setInterval(() => {
    for (const id of followed) void pruneAttachments(id);
  }, PRUNE_EVERY_MS);
}

registerWorkspaceCleanup((workspaceId) => {
  followed.delete(workspaceId);
  roots.delete(workspaceId);
  touched.delete(workspaceId);
  for (const known of [historySlots, historyFailed, historyAbsent]) {
    for (const key of known.keys()) if (key.startsWith(`${workspaceId}\n`)) known.delete(key);
  }
  waiting.delete(workspaceId);
  const prefix = `${workspaceId}:`;
  for (const key of looked.keys()) if (key.startsWith(prefix)) looked.delete(key);
});

/**
 * Prunes the workspace's attached files (chat.pruneAttachments): the open
 * chat tabs' and what their conversations name stay; with `capOnly`, only
 * the room is made. Nothing goes while a history is not known, or while
 * they name more than a call can (MAX_CALL_SLOTS). Files are kept by use only once the agent tells its
 * attach root, so a file an open conversation names is never taken for an
 * unused one; false while it tells none. Main then prunes only where the
 * agent names no root (a home it cannot name, or an agent from before),
 * whose files go as their tabs close: those of the tabs not open go.
 */
export async function pruneAttachments(workspaceId: string, capOnly = false): Promise<boolean> {
  const root = await rootOf(workspaceId);
  const tabs = chatTabsOf(workspaceId);
  const keepTabIds = tabs.map((tab) => tab.id);
  if (!root) {
    if (!capOnly) {
      unwrapIpcResult(await ipcCallResult("chat", "pruneAttachments", { workspaceId, keepTabIds }));
    }
    return false;
  }
  await readOpenHistories(workspaceId);
  const kept = keptSlots(workspaceId, tabs, root);
  // What an open conversation names early on is not known: nothing goes now.
  if (!kept) throw new Error("an open conversation's history could not be read");
  // An open tab's own folder stays by its id.
  const open = new Set(keepTabIds);
  const keepSlots = [...kept].filter((slot) => !open.has(slot.slice(0, slot.indexOf("/"))));
  // More than one call names: one left out would go as unused, so none goes now.
  if (keepSlots.length > MAX_CALL_SLOTS) {
    throw new Error("the open conversations name more attachments than a prune can keep");
  }
  unwrapIpcResult(
    await ipcCallResult("chat", "pruneAttachments", {
      workspaceId,
      keepTabIds,
      keepSlots,
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
    void pruneAttachments(workspaceId)
      .catch((error: Error) => {
        log.warn(`pruning attachments failed: ${error.message}`);
        return false;
      })
      .then((done) => {
        if (done || ++tries >= ROOT_TRIES) return;
        waiting.set(workspaceId, setTimeout(attempt, ROOT_RETRY_MS));
      });
  };
  attempt();
}

/** After a file is attached: the room is made, the rest left to the next prune. */
export function pruneAttachmentsAfterAttach(workspaceId: string): void {
  void pruneAttachments(workspaceId, true).catch((error: Error) =>
    log.warn(`making room for attachments failed: ${error.message}`),
  );
}

/**
 * Removes the attached files a deleted conversation's items named (written
 * from `cwd`), but those an open chat tab uses: in its own folder, or named
 * by its conversation, its whole history as asked before the conversation
 * went (readOpenHistories), a fork's too. None go while an open tab's
 * history is not known; the prune of unused ones takes them later.
 */
export async function removeConversationAttachments(
  workspaceId: string,
  items: readonly ChatItem[],
  cwd: string,
): Promise<void> {
  const root = await rootOf(workspaceId);
  if (!root) return;
  const named = slotsOf(attachedFilesIn(items, cwd), root, workspaceId);
  if (named.length === 0) return;
  const tabs = chatTabsOf(workspaceId);
  const openTabs = new Set(tabs.map((tab) => tab.id));
  // Read before the conversation went (readOpenHistories), as a fork's may be its.
  const used = keptSlots(workspaceId, tabs, root);
  if (!used) return;
  const slots = named.filter(
    (slot) => !used.has(slot) && !openTabs.has(slot.slice(0, slot.indexOf("/"))),
  );
  await slotCalls("removeAttachments", workspaceId, slots);
}

/** For tests: looks at the followed chats now, not once they settle. */
export function followAttachmentsNow(): Promise<void> {
  return followAll();
}

/** For tests: forgets what was followed. */
export function resetAttachmentRetention(): void {
  unsubscribe?.();
  unsubscribe = undefined;
  unsubscribeTabs?.();
  unsubscribeTabs = undefined;
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
  historySlots.clear();
  historyFailed.clear();
  historyAbsent.clear();
  askingHistory.clear();
}
