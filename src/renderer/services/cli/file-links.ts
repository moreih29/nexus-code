import type { FileLinkSource } from "../../../../packages/remote-protocol/src";
import { cleanLinkHref, sameLinkHref, textLinksTo } from "../../../shared/chat/link-text";
import { networkLinkPath } from "../../../shared/fs/outside-url";
import { ipcCallResult } from "../../ipc/client";
import { useTabsStore } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { attachRootOf, attachSlotOf } from "../chat/attach-folders";
import { linkPlaceIndex, linkPlaces } from "../chat/link-places";
import { resolveFileLink, resolveFilePath } from "../chat/links";
import type { ChatItem, ChatModel, ToolCall } from "../chat/model";
import {
  attachedFilesOf,
  changedFilesOf,
  changedShareFiles,
  hostedOutsideFiles,
  jobOutputFile,
  jobsOf,
  MAX_OUTSIDE_FILES,
  outsideLinksOf,
  sentFilesOf,
  touchedFiles,
} from "../chat/panel";
import { type ChatTabState, chatKey, useChatStore } from "../chat/store";
import { type ChatSource, conversationOf } from "../remote/chat-page";

export type ChatLinkSource = Exclude<FileLinkSource, { kind: "file" }>;

export interface OutsideFiles {
  files: string[];
  standing: string[];
  agent: string[];
}

const LOOK_ONLY_TOOLS = new Set(["Read", "NotebookRead", "ViewImage"]);

function pathKey(path: string): string {
  return /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path;
}

function agentFilesOf(
  items: ChatItem[],
  tools: Record<string, ToolCall>,
  cwd: string,
  root: string,
  attached: (file: string) => boolean,
): string[] {
  const kept = Object.fromEntries(
    Object.entries(tools).filter(([, tool]) => !LOOK_ONLY_TOOLS.has(tool.name)),
  );
  const users = items.filter((item) => item.kind === "user");
  return outsideLinksOf(users, kept, cwd, root, [], attached).files;
}

export async function outsideFilesOf(workspaceId: string): Promise<OutsideFiles> {
  const root = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId)?.rootPath;
  const files = new Set<string>();
  const standing = new Set<string>();
  const agent = new Set<string>();
  const attachRoot = root ? await attachRootOf(workspaceId) : null;
  for (const tab of Object.values(useTabsStore.getState().byWorkspace[workspaceId] ?? {})) {
    if (tab.type !== "claude" && tab.type !== "codex") continue;
    const chat = useChatStore.getState().tabs[chatKey(workspaceId, tab.id)];
    if (!chat) continue;
    const { model, history } = chat;
    const items = history ? [...history.items, ...model.items] : model.items;
    const tools = history ? { ...history.tools, ...model.tools } : model.tools;
    const both = (file: string) => {
      standing.add(file);
      agent.add(file);
    };
    for (const job of jobsOf(model)) {
      const path = jobOutputFile(job, tools);
      if (path) {
        files.add(path);
        both(path);
      }
    }
    const attached = (file: string) =>
      attachRoot !== null && attachSlotOf(attachRoot, workspaceId, file) !== null;
    if (root) {
      const cwd = tab.props.cwd;
      for (const file of hostedOutsideFiles(items, tools, cwd, root, attached)) files.add(file);
      for (const file of outsideLinksOf(items, tools, cwd, root, [], attached).files) {
        standing.add(file);
      }
      for (const file of agentFilesOf(items, tools, cwd, root, attached)) agent.add(file);
      for (const file of changedShareFiles(tools, root)) {
        files.add(file);
        both(file);
      }
    }
  }
  const last = (set: Set<string>) => [...set].slice(-MAX_OUTSIDE_FILES);
  return { files: last(files), standing: last(standing), agent: last(agent) };
}

function itemOf(
  conversation: ReturnType<typeof conversationOf>,
  key: string,
): ChatItem | undefined {
  return (
    conversation.items.find((item) => item.key === key) ??
    Object.values(conversation.agentItems)
      .flat()
      .find((item) => item.key === key)
  );
}

function textOfItem(item: ChatItem | undefined, kind: ChatItem["kind"]): string | null {
  if (!item || item.kind !== kind) return null;
  if (item.kind === "assistant") {
    return item.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
  }
  if (item.kind === "received") return item.text;
  if (item.kind === "task_end") return item.summary ?? "";
  return null;
}

function streamedTexts(model: ChatModel, items: ChatItem[], messageId: string): string[] {
  const texts: string[] = [];
  if (model.streaming?.messageId === messageId) {
    for (const block of Object.values(model.streaming.blocks)) {
      if (block.type === "text") texts.push(block.text);
    }
  }
  for (const item of items) {
    if (item.kind === "assistant" && item.messageId === messageId) {
      texts.push(textOfItem(item, "assistant") ?? "");
    }
  }
  return texts;
}

function hasStream(model: ChatModel, items: ChatItem[], messageId: string): boolean {
  return (
    model.streaming?.messageId === messageId ||
    items.some((item) => item.kind === "assistant" && item.messageId === messageId)
  );
}

function placesFor(href: string, base: string, tools?: Record<string, ToolCall>): string[] {
  const cleaned = cleanLinkHref(href);
  const network = networkLinkPath(cleaned);
  if (network !== null) return [network];
  const found = tools
    ? linkPlaces(cleaned, linkPlaceIndex(tools, base)).map((place) => place.path)
    : [resolveFileLink(cleaned, base)?.path].filter((path): path is string => !!path);
  return [...new Set(found)];
}

function toolPaths(tool: ToolCall): string[] {
  const input = tool.input as Record<string, unknown> | null | undefined;
  const named = [input?.file_path, input?.notebook_path].filter(
    (value): value is string => typeof value === "string" && value !== "",
  );
  return [...named, ...sentFilesOf(tool)];
}

const INPUT_TEXT_KEYS = ["plan", "prompt", "description", "content"] as const;

function inputTexts(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const fields = input as Record<string, unknown>;
  return INPUT_TEXT_KEYS.flatMap((key) => {
    const value = fields[key];
    return typeof value === "string" ? [value] : [];
  });
}

export function linkCandidates(
  source: ChatSource,
  cwd: string,
  href: string,
  from: ChatLinkSource,
  allowsAttachment: (file: string) => boolean = () => true,
): string[] | null {
  const conversation = conversationOf(source);
  const { items, tools } = conversation;
  const found = (places: string[]) => (places.length > 0 ? places : null);
  switch (from.kind) {
    case "answer": {
      const text = textOfItem(itemOf(conversation, from.itemKey), "assistant");
      if (text === null) return null;
      const touched = touchedFiles(tools, cwd);
      const code = (written: string) => {
        const path = resolveFilePath(written, cwd);
        return path !== null && touched.has(pathKey(path));
      };
      return textLinksTo(text, href, { code }) ? found(placesFor(href, cwd, tools)) : null;
    }
    case "received":
    case "taskEnd": {
      const kind = from.kind === "received" ? "received" : "task_end";
      const text = textOfItem(itemOf(conversation, from.itemKey), kind);
      return text !== null && textLinksTo(text, href) ? found(placesFor(href, cwd)) : null;
    }
    case "streaming": {
      const texts = streamedTexts(source.chat.model, items, from.messageId);
      return texts.some((text) => textLinksTo(text, href))
        ? found(placesFor(href, cwd, tools))
        : null;
    }
    case "tool": {
      const tool = tools[from.toolUseId];
      const asking = source.chat.model.permissions.find((p) => p.toolUseId === from.toolUseId);
      if (!tool && !asking) return null;
      const input = (tool?.input ?? asking?.input) as Record<string, unknown> | null | undefined;
      const base = typeof input?.cwd === "string" && input.cwd !== "" ? input.cwd : cwd;
      const named = tool ? toolPaths(tool).some((path) => sameLinkHref(path, href)) : false;
      const texts = [
        tool?.result?.text ?? "",
        ...inputTexts(tool?.input),
        ...inputTexts(asking?.input),
      ];
      if (!named && !texts.some((text) => textLinksTo(text, href))) return null;
      return found(placesFor(href, base));
    }
    case "user": {
      const item = itemOf(conversation, from.itemKey);
      if (item?.kind !== "user") return null;
      if (networkLinkPath(cleanLinkHref(href)) !== null) return null;
      const path = resolveFilePath(cleanLinkHref(href), cwd);
      if (!path || !attachedFilesOf(item, cwd).includes(path)) return null;
      return allowsAttachment(path) ? [path] : null;
    }
    case "job": {
      const job = jobsOf(source.chat.model).find((task) => task.taskId === from.taskId);
      const path = job ? jobOutputFile(job, tools) : undefined;
      return path && sameLinkHref(path, href) ? [path] : null;
    }
    case "change": {
      const file = changedFilesOf(tools).find(
        (changed) =>
          sameLinkHref(changed.path, href) ||
          (changed.rawPath !== undefined && sameLinkHref(changed.rawPath, href)),
      );
      return file ? [file.path] : null;
    }
  }
}

export function sourcePresent(source: ChatSource, from: FileLinkSource): boolean {
  const conversation = conversationOf(source);
  switch (from.kind) {
    case "answer":
      return itemOf(conversation, from.itemKey)?.kind === "assistant";
    case "received":
      return itemOf(conversation, from.itemKey)?.kind === "received";
    case "taskEnd":
      return itemOf(conversation, from.itemKey)?.kind === "task_end";
    case "user":
      return itemOf(conversation, from.itemKey)?.kind === "user";
    case "streaming":
      return hasStream(source.chat.model, conversation.items, from.messageId);
    case "tool":
      return (
        conversation.tools[from.toolUseId] !== undefined ||
        source.chat.model.permissions.some((p) => p.toolUseId === from.toolUseId)
      );
    case "job":
      return jobsOf(source.chat.model).some((task) => task.taskId === from.taskId);
    case "change":
    case "file":
      return true;
  }
}

function itemCount(chat: ChatTabState | undefined): number {
  return chat ? (chat.history?.items.length ?? 0) + chat.model.items.length : 0;
}

let stopWatching: (() => void) | null = null;
const shrunk = new Set<string>();

function tellShrunk(key: string): void {
  if (shrunk.has(key)) return;
  shrunk.add(key);
  queueMicrotask(() => {
    shrunk.delete(key);
    const at = key.indexOf(":");
    void ipcCallResult("remote", "chatSourcesChanged", {
      workspaceId: key.slice(0, at),
      tabId: key.slice(at + 1),
    }).catch(() => {});
  });
}

export function stopWatchingChatSources(): void {
  stopWatching?.();
  stopWatching = null;
}

export function watchChatSources(): void {
  if (stopWatching) return;
  const stopChats = useChatStore.subscribe((state, prev) => {
    if (state.tabs === prev.tabs) return;
    for (const [key, was] of Object.entries(prev.tabs)) {
      const now = state.tabs[key];
      if (now === was) continue;
      if (itemCount(now) < itemCount(was)) tellShrunk(key);
    }
  });
  const stopTabs = useTabsStore.subscribe((state, prev) => {
    if (state.byWorkspace === prev.byWorkspace) return;
    for (const [workspaceId, tabs] of Object.entries(prev.byWorkspace)) {
      for (const [tabId, tab] of Object.entries(tabs ?? {})) {
        if (tab.type !== "claude" && tab.type !== "codex") continue;
        if (!state.byWorkspace[workspaceId]?.[tabId]) tellShrunk(chatKey(workspaceId, tabId));
      }
    }
  });
  stopWatching = () => {
    stopChats();
    stopTabs();
  };
}
