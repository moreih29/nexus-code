import type { ClaudeStatus } from "../../../shared/claude/status";
import { STATUS_PRIORITY } from "../../state/stores/claude-status";
import type { Tab } from "../../state/stores/tabs";
import type { ChatModel } from "../chat/model";
import { type ChatTabState, chatKey } from "../chat/store";

export const RUN_STARTED_AT = Date.now();

export interface CodexSessionState {
  readonly state: ClaudeStatus;
  readonly since: number | undefined;
  readonly message: string | undefined;
  readonly prompt: string | undefined;
}

export function codexStateOf(
  chat: ChatTabState | undefined,
  seenAt: number | undefined,
  viewing: boolean,
  runStartedAt: number = RUN_STARTED_AT,
): CodexSessionState {
  if (!chat) return { state: "idle", since: undefined, message: undefined, prompt: undefined };
  const { model } = chat;
  const told = { message: lastAnswer(model), prompt: lastPrompt(model) };
  if (model.permissions.length > 0) {
    const asks = model.permissions.some((p) => p.toolName === "AskUserQuestion");
    return {
      state: asks ? "needsInput" : "permissionPending",
      since: model.turn?.startedAt,
      ...told,
    };
  }
  if (chat.phase === "failed" || chat.phase === "not-found") {
    return { state: "error", since: undefined, ...told };
  }
  if (model.running) return { state: "running", since: model.turn?.startedAt, ...told };
  const result = model.lastResult;
  const endedAt = result?.at;
  const unseen =
    endedAt !== undefined &&
    endedAt >= runStartedAt &&
    !viewing &&
    (seenAt === undefined || seenAt < endedAt);
  if (unseen && result?.subtype !== "interrupted") {
    return { state: result?.isError ? "error" : "completed", since: endedAt, ...told };
  }
  return { state: "idle", since: endedAt, ...told };
}

export function claudeChatStateOf(
  chat: ChatTabState | undefined,
  seenAt: number | undefined,
  viewing: boolean,
): CodexSessionState | undefined {
  if (!chat) return undefined;
  const { model } = chat;
  const result = model.lastResult;
  if (!model.running && model.permissions.length === 0 && result?.outcome) {
    if (result.outcome === "interrupted") {
      return {
        state: "idle",
        since: result.at,
        message: lastAnswer(model),
        prompt: lastPrompt(model),
      };
    }
    if (result.outcome === "error") {
      return { state: "error", since: result.at, message: result.error, prompt: lastPrompt(model) };
    }
  }
  if (
    result?.outcome ||
    model.running ||
    model.permissions.length > 0 ||
    chat.phase === "failed" ||
    chat.phase === "not-found"
  ) {
    return codexStateOf(chat, seenAt, viewing);
  }
  return undefined;
}

export function workspaceCodexState(
  workspaceIds: readonly string[],
  tabs: Readonly<Record<string, Readonly<Record<string, Tab>> | undefined>>,
  seen: Readonly<Record<string, Readonly<Record<string, number>> | undefined>>,
  chats: Readonly<Record<string, ChatTabState>>,
  viewing: string | null,
  runStartedAt: number = RUN_STARTED_AT,
): ClaudeStatus | null {
  let strongest: ClaudeStatus | null = null;
  for (const workspaceId of workspaceIds) {
    for (const tab of Object.values(tabs[workspaceId] ?? {})) {
      if (tab.type !== "codex") continue;
      const key = chatKey(workspaceId, tab.id);
      const { state } = codexStateOf(
        chats[key],
        seen[workspaceId]?.[tab.id],
        key === viewing,
        runStartedAt,
      );
      if (state === "idle") continue;
      if (strongest === null || STATUS_PRIORITY[state] > STATUS_PRIORITY[strongest]) {
        strongest = state;
      }
    }
  }
  return strongest;
}

export function lastAnswer(model: ChatModel): string | undefined {
  for (let i = model.items.length - 1; i >= 0; i--) {
    const item = model.items[i];
    if (item.kind === "user") return undefined;
    if (item.kind !== "assistant") continue;
    const text = item.blocks
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n\n")
      .trim();
    if (text !== "") return text;
  }
  return undefined;
}

export function lastPrompt(model: ChatModel): string | undefined {
  for (let i = model.items.length - 1; i >= 0; i--) {
    const item = model.items[i];
    if (item.kind === "user") return item.text.trim() || undefined;
  }
  return undefined;
}
