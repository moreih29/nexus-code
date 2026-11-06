/**
 * A Codex tab's state, read from its conversation: no hook reports it, as
 * Claude's hooks do for a Claude tab. Pure.
 */

import type { ChatModel } from "../chat/model";
import type { ChatTabState } from "../chat/store";

/** When this run of the app started: a turn that ended before it counts as looked at. */
export const RUN_STARTED_AT = Date.now();

export interface CodexSessionState {
  /**
   * In Claude's words: permissionPending, needsInput (a question), error,
   * running, completed (a turn not looked at yet) or idle.
   */
  readonly state: string;
  /** When the state began, as far as the conversation tells it. */
  readonly since: number | undefined;
  /** The last answer. */
  readonly message: string | undefined;
  /** The last prompt. */
  readonly prompt: string | undefined;
}

/**
 * The state of a Codex tab whose conversation is `chat`. A finished turn is
 * new until the user looks at the tab: `seenAt` is when they last had it in
 * front of them, and `viewing` is whether they have it now.
 */
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
  // A turn the user stopped is no news.
  if (unseen && result?.subtype !== "interrupted") {
    return { state: result?.isError ? "error" : "completed", since: endedAt, ...told };
  }
  return { state: "idle", since: endedAt, ...told };
}

/** The text of the answer to the last prompt, if it has any yet. */
function lastAnswer(model: ChatModel): string | undefined {
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

function lastPrompt(model: ChatModel): string | undefined {
  for (let i = model.items.length - 1; i >= 0; i--) {
    const item = model.items[i];
    if (item.kind === "user") return item.text.trim() || undefined;
  }
  return undefined;
}
