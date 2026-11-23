import { createLogger } from "../../../shared/log/renderer";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import { type ClaudeTab, type CodexTab, useTabsStore } from "../../state/stores/tabs";
import { registerWorkspaceCleanup } from "../../state/workspace-cleanup";
import { attachRootOf, attachSlotOf } from "./attach-folders";
import type { ChatItem, ChatModel } from "./model";
import { attachedFilesOf } from "./panel";
import { chatKey, useChatStore } from "./store";

const log = createLogger("attach-retention");

export const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
const SETTLE_MS = 1_000;
const ROOT_KNOWN_MS = 60_000;
const ROOT_RETRY_MS = 30_000;
const ROOT_TRIES = 10;
export const HISTORY_RETRY_MS = 60_000;
const MAX_TAB_SLOTS = 500;
const MAX_CALL_SLOTS = 5_000;

type ChatTab = ClaudeTab | CodexTab;

function chatTabsOf(workspaceId: string): ChatTab[] {
  return Object.values(useTabsStore.getState().byWorkspace[workspaceId] ?? {}).filter(
    (tab): tab is ChatTab => tab.type === "claude" || tab.type === "codex",
  );
}

const roots = new Map<string, { at: number; root: Promise<string | null> }>();

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

export function slotsOf(files: Iterable<string>, root: string, workspaceId: string): string[] {
  const slots = new Set<string>();
  for (const file of files) {
    const slot = attachSlotOf(root, workspaceId, file);
    if (slot) slots.add(slot);
  }
  return [...slots];
}

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

interface History {
  agent: "claude" | "codex";
  conversation: string;
  profileId?: string;
}

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

const historySlots = new Map<string, readonly string[]>();
const historyFailed = new Map<string, { at: number; error: unknown }>();
const historyAbsent = new Map<string, number>();
const askingHistory = new Map<string, Promise<readonly string[]>>();

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

async function historySlotsOf(workspaceId: string, tab: ChatTab, again = false): Promise<string[]> {
  const named = await Promise.all(
    historiesOf(workspaceId, tab).map((history) => historyOf(workspaceId, history, again)),
  );
  return [...new Set(named.flat())];
}

export async function readOpenHistories(workspaceId: string): Promise<boolean> {
  const asked = await Promise.allSettled(
    chatTabsOf(workspaceId).map((tab) => historySlotsOf(workspaceId, tab, true)),
  );
  return asked.every((result) => result.status === "fulfilled");
}

function askedHistorySlots(workspaceId: string, tab: ChatTab): string[] | null {
  const slots: string[] = [];
  for (const history of historiesOf(workspaceId, tab)) {
    const key = historyKey(workspaceId, history);
    const named = historySlots.get(key) ?? (historyAbsent.has(key) ? [] : undefined);
    if (!named) return null;
    slots.push(...named);
  }
  return slots;
}

const looked = new Map<string, { key: string; history: unknown; live: unknown }>();
const touched = new Map<string, Set<string>>();

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
  const early = await historySlotsOf(workspaceId, tab).catch(() => []);
  const slots = [...new Set([...early, ...loaded])];
  if (slots.length === 0) return;
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
  if (!kept) throw new Error("an open conversation's history could not be read");
  const open = new Set(keepTabIds);
  const keepSlots = [...kept].filter((slot) => !open.has(slot.slice(0, slot.indexOf("/"))));
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

const waiting = new Map<string, ReturnType<typeof setTimeout>>();

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

export function pruneAttachmentsAfterAttach(workspaceId: string): void {
  void pruneAttachments(workspaceId, true).catch((error: Error) =>
    log.warn(`making room for attachments failed: ${error.message}`),
  );
}

export async function removeConversationAttachments(
  workspaceId: string,
  items: readonly ChatItem[],
  cwd: string,
  inherited: readonly ChatItem[] = [],
): Promise<void> {
  const root = await rootOf(workspaceId);
  if (!root) return;
  const theirs = new Set(slotsOf(attachedFilesIn(inherited, cwd), root, workspaceId));
  const named = slotsOf(attachedFilesIn(items, cwd), root, workspaceId).filter(
    (slot) => !theirs.has(slot),
  );
  if (named.length === 0) return;
  const tabs = chatTabsOf(workspaceId);
  const openTabs = new Set(tabs.map((tab) => tab.id));
  const used = keptSlots(workspaceId, tabs, root);
  if (!used) return;
  const slots = named.filter(
    (slot) => !used.has(slot) && !openTabs.has(slot.slice(0, slot.indexOf("/"))),
  );
  await slotCalls("removeAttachments", workspaceId, slots);
}

export function followAttachmentsNow(): Promise<void> {
  return followAll();
}

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
