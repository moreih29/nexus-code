// The conversation a Codex tab shows, rebuilt from the lines of its
// program's log: the JSON-RPC that `codex app-server` wrote (out), what the
// app wrote it (in), and the agent's own lines (sys): the program's start
// and exit, and the files the session changed as they were before it.
//
// It builds the model a Claude tab builds, so a Codex tab shows it with the
// same list, rows and cards: a turn is an assistant message, an item of it
// a block. Like applyLine it is a pure reducer, so the same lines give the
// same view live and when a reloaded window replays the log.
//
// The app server is experimental and its protocol grows with each Codex
// release (#159): methods and fields it does not know are left alone, and
// every field is read as maybe absent.

import { fileMention } from "./composer-input";
import {
  type AssistantBlock,
  type AssistantItem,
  applySys,
  type ChatLine,
  type ChatModel,
  Draft,
  emptyModel,
  type ImageBlock,
  type ModelInfo,
  num,
  type PermissionRequest,
  rec,
  stopRunningTools,
  str,
  type ToolCall,
  type UserItem,
} from "./model";

type Rec = Record<string, unknown>;

/** The approval and sandbox presets a Codex tab offers, as Codex's own /approvals does. */
export type CodexMode = "readOnly" | "auto" | "fullAccess";

export const CODEX_MODES: readonly CodexMode[] = ["readOnly", "auto", "fullAccess"];

/** A request of the server's the app has yet to answer: an approval, a question. */
/** One of the plan's usage windows, as Codex reports it. */
export interface CodexLimitWindow {
  usedPercent: number;
  /** How long the window is, in minutes: 300 for the 5-hour one, 10080 for the week. */
  windowMins?: number;
  /** When it starts over, in seconds since the epoch. */
  resetsAt?: number;
}

/** The plan's usage limits: a short window and a long one, when the plan has them. */
export interface CodexRateLimits {
  /** The bucket the windows are of, such as "codex", to keep other buckets' updates out. */
  limitId?: string;
  primary?: CodexLimitWindow;
  secondary?: CodexLimitWindow;
}

export interface CodexServerRequest {
  method: string;
  params: Rec;
}

export interface CodexModel extends ChatModel {
  /** The thread the program runs, once it started or resumed one. */
  threadId?: string;
  /** The turn that runs, to steer or stop. */
  turnId?: string;
  /** What the program is signed in with (its kind only); null when it is not. */
  account?: { type: string } | null;
  /** The program needs a sign-in before a turn can run. */
  signedOut?: boolean;
  /** The thread's context: the tokens of its last request, and the model's window. */
  tokens?: { used: number; window?: number };
  /** The plan's usage limits; only a ChatGPT sign-in has them. */
  rateLimits?: CodexRateLimits;
  threadName?: string;
  /** Where the text an item streams goes: its message's key and the block's index. */
  blocks: Record<string, { key: string; index: number }>;
  /** The server's requests waiting for an answer, by their JSON id. */
  requests: Record<string, CodexServerRequest>;
  /**
   * The files the session changed as they were before its first change,
   * by path as the agent wrote it; null for a file it wrote new. Only the
   * agent's, which it checked against the hashes in Codex's turn diff.
   */
  originals: Record<string, string | null>;
}

export function emptyCodexModel(): CodexModel {
  return { ...emptyModel(), blocks: {}, requests: {}, originals: {} };
}

/**
 * The model a tab starts another thread with (/new, /resume): empty but
 * for what is the program's or the account's, shown on while the next
 * handshake reads it again: the models, the sign-in, the usage limits.
 */
export function nextThreadModel(prev: CodexModel): CodexModel {
  const { lastSeq, init, version, account, signedOut, rateLimits } = prev;
  return { ...emptyCodexModel(), lastSeq, init, version, account, signedOut, rateLimits };
}

/** A JSON-RPC id as a key, so the number 1 and the string "1" stay apart. */
export function idKey(id: unknown): string | null {
  return typeof id === "string" || typeof id === "number" ? JSON.stringify(id) : null;
}

/** Requests the app makes on its own, whose errors are not the conversation's. */
const QUIET_REQUESTS = new Set([
  "model/list",
  "account/read",
  "account/rateLimits/read",
  "fuzzyFileSearch",
]);

/** Most of a running command's output a row keeps; the start goes first. */
const MAX_LIVE_OUTPUT = 100_000;

/** Applies one line to the model. Lines at or before lastSeq are skipped. */
export function applyCodexLine(
  prev: CodexModel,
  line: ChatLine,
  now: number = Date.now(),
): CodexModel {
  if (line.seq <= prev.lastSeq) return prev;
  const draft = new Draft(prev);
  draft.next.lastSeq = line.seq;
  const message = rec(line.message);
  if (!message) return draft.next;
  const at = line.at ?? (line.replay ? undefined : now);
  if (line.dir === "sys" && message.event === "snapshot") {
    const path = str(message.path);
    const before = message.before;
    if (path && (typeof before === "string" || before === null)) {
      draft.next.originals = { ...draft.next.originals, [path]: before };
    }
  } else if (line.dir === "sys") {
    applySys(draft, message, line.seq, at);
    if (message.event === "start" || message.event === "exit") {
      // A program's requests and turn end with it; the thread goes on.
      draft.next.requests = {};
      draft.next.blocks = {};
      draft.next.turnId = undefined;
    }
  } else if (line.dir === "in") applyIn(draft, message, line.seq, at);
  else applyOut(draft, message, line.seq, at);
  return draft.next;
}

export function applyCodexLines(
  prev: CodexModel,
  lines: readonly ChatLine[],
  now?: number,
): CodexModel {
  let model = prev;
  for (const line of lines) model = applyCodexLine(model, line, now);
  return model;
}

type CodexDraft = Draft<CodexModel>;

// ---------------------------------------------------------------------------
// What the app wrote: its requests, and its answers to the server's.
// ---------------------------------------------------------------------------

function applyIn(draft: CodexDraft, message: Rec, seq: number, at: number | undefined): void {
  const m = draft.next;
  const key = idKey(message.id);
  const method = str(message.method);
  if (method) {
    const params = rec(message.params) ?? {};
    if (key) m.outgoing = { ...m.outgoing, [key]: { subtype: method, request: params } };
    switch (method) {
      case "turn/start":
      case "turn/steer": {
        const { text, images } = userInputOf(params.input);
        draft.push({ kind: "user", key: userKey(params, seq), text, images, state: "sent", at });
        if (method === "turn/start") {
          applySettings(m, {
            model: params.model,
            effort: params.effort,
            sandbox: params.sandboxPolicy,
          });
          if (!m.running) {
            m.running = true;
            m.turn = { startedAt: at, outputTokens: 0, thinkingTokens: 0 };
          }
        }
        return;
      }
      case "turn/interrupt":
        if (m.running) m.interrupting = true;
        return;
    }
    return;
  }
  // The app answered a request of the server's.
  if (!key || !m.requests[key]) return;
  const { [key]: request, ...rest } = m.requests;
  m.requests = rest;
  m.permissions = m.permissions.filter((p) => p.requestId !== key);
  const decision = rec(message.result)?.decision;
  const itemId = str(request.params.itemId);
  if ((decision === "decline" || decision === "cancel") && itemId) {
    for (const id of toolIdsOf(m, itemId)) {
      draft.setTool(id, (t) => ({ ...(t as ToolCall), status: "denied" }));
    }
  }
}

/** The key of a message the app sent: by its client id, which the server's item echoes. */
function userKey(params: Rec, seq: number): string {
  const clientId = str(params.clientUserMessageId);
  return clientId ? `u-${clientId}` : `u${seq}`;
}

// ---------------------------------------------------------------------------
// What the server wrote: answers, notifications and requests of its own.
// ---------------------------------------------------------------------------

function applyOut(draft: CodexDraft, message: Rec, seq: number, at: number | undefined): void {
  const method = str(message.method);
  const key = idKey(message.id);
  const params = rec(message.params) ?? {};
  if (method && key) applyServerRequest(draft, key, method, params);
  else if (method) applyNotification(draft, method, params, seq, at);
  else if (key) applyResponse(draft, key, message, seq, at);
}

function applyResponse(
  draft: CodexDraft,
  key: string,
  message: Rec,
  seq: number,
  at: number | undefined,
): void {
  const m = draft.next;
  const sent = m.outgoing[key];
  if (!sent) return;
  const { [key]: _done, ...rest } = m.outgoing;
  m.outgoing = rest;
  const error = rec(message.error);
  if (error) {
    if (QUIET_REQUESTS.has(sent.subtype)) return;
    if (sent.subtype === "turn/steer") {
      // The turn ended first: the app sends the message as the next turn's.
      const clientId = str(sent.request.clientUserMessageId);
      const index = m.items.findIndex((i) => i.kind === "user" && i.key === `u-${clientId}`);
      if (clientId && index >= 0) draft.items().splice(index, 1);
      return;
    }
    if (sent.subtype === "thread/resume") {
      // The app starts a new thread instead, and says so where the tab had a
      // conversation to go on with. One that never had a turn was never
      // saved by Codex, so it cannot be resumed and nothing is lost.
      if (!m.items.some((i) => i.kind !== "notice")) return;
      // The server's reason is for the log and the notice's tooltip.
      draft.push({
        kind: "notice",
        key: `n${seq}`,
        code: "not_resumed",
        detail: str(error.message),
        at,
      });
      return;
    }
    if (sent.subtype === "turn/start") {
      m.running = false;
      m.turn = null;
      m.interrupting = false;
    }
    const detail = str(error.message) ?? sent.subtype;
    draft.push({ kind: "notice", key: `n${seq}`, code: "error", detail, at });
    return;
  }
  const result = rec(message.result) ?? {};
  switch (sent.subtype) {
    case "thread/start":
    case "thread/resume":
    case "thread/fork":
      applyThread(draft, result, seq);
      return;
    case "turn/start":
    case "turn/steer": {
      const turnId = str(rec(result.turn)?.id) ?? str(result.turnId);
      if (sent.subtype === "turn/start" && turnId && m.running) enterTurn(m, turnId);
      const clientId = str(sent.request.clientUserMessageId);
      if (clientId) takeUser(draft, `u-${clientId}`, undefined);
      return;
    }
    case "model/list":
      m.init = { commands: [], models: modelsOf(result.data), remoteControl: false };
      return;
    case "account/read":
      m.account = accountOf(result.account);
      m.signedOut = m.account === null && result.requiresOpenaiAuth === true;
      return;
    case "account/rateLimits/read":
      // A read with no windows leaves the last ones shown.
      m.rateLimits = rateLimitsOf(result.rateLimits) ?? m.rateLimits;
      return;
  }
}

/** A started or resumed thread: its settings, and the turns it had when resumed. */
function applyThread(draft: CodexDraft, result: Rec, seq: number): void {
  const m = draft.next;
  const thread = rec(result.thread);
  m.threadId = str(thread?.id) ?? m.threadId;
  m.threadName = str(thread?.name) ?? m.threadName;
  m.version = str(thread?.cliVersion) ?? m.version;
  m.cwd = str(result.cwd) ?? m.cwd;
  applySettings(m, {
    model: result.model,
    effort: result.reasoningEffort,
    sandbox: result.sandbox,
  });
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  turns.forEach((raw, t) => {
    const turn = rec(raw);
    const turnId = str(turn?.id);
    if (!turn || !turnId || !Array.isArray(turn.items)) return;
    const startedAt = num(turn.startedAt);
    inStartOrder(turn.items).forEach(({ item, i }) => {
      const at = num(item.startedAtMs) ?? (startedAt !== undefined ? startedAt * 1000 : undefined);
      applyItem(draft, turnId, item, "completed", `${seq}.${t}.${i}`, at);
    });
  });
}

/**
 * A resumed turn's items in the order they started, as the turn showed
 * them live. The server lists them as they ended: a command left running
 * while Codex answered comes after the answer. Kept as listed when an
 * item does not say when it started.
 */
function inStartOrder(raw: unknown[]): { item: Rec; i: number }[] {
  const items = raw.flatMap((value, i) => {
    const item = rec(value);
    return item ? [{ item, i }] : [];
  });
  if (items.some(({ item }) => num(item.startedAtMs) === undefined)) return items;
  return items.sort((a, b) => (num(a.item.startedAtMs) ?? 0) - (num(b.item.startedAtMs) ?? 0));
}

function applySettings(
  m: CodexModel,
  settings: { model: unknown; effort: unknown; sandbox: unknown },
) {
  m.model = str(settings.model) ?? m.model;
  m.effort = str(settings.effort) ?? m.effort;
  m.permissionMode = modeOf(settings.sandbox) ?? m.permissionMode;
}

/** The preset a sandbox reads as: its policy ({type}) or its mode ("read-only"). */
export function modeOf(sandbox: unknown): CodexMode | undefined {
  const kind = typeof sandbox === "string" ? sandbox : str(rec(sandbox)?.type);
  switch (kind) {
    case "readOnly":
    case "read-only":
      return "readOnly";
    case "workspaceWrite":
    case "workspace-write":
      return "auto";
    case "dangerFullAccess":
    case "danger-full-access":
      return "fullAccess";
  }
  return undefined;
}

/** Thread notifications about the tab's own thread alone. */
const OWN_THREAD_ONLY = new Set(["thread/tokenUsage/updated", "thread/compacted"]);

function applyNotification(
  draft: CodexDraft,
  method: string,
  params: Rec,
  seq: number,
  at: number | undefined,
): void {
  const m = draft.next;
  const tag = String(seq);
  // Another thread's (a subagent's) turns and items are not the tab's, nor
  // its context's size and compactions.
  const threadId = str(params.threadId);
  const another = threadId && m.threadId && threadId !== m.threadId;
  if (another && (!method.startsWith("thread/") || OWN_THREAD_ONLY.has(method))) return;
  switch (method) {
    case "turn/started": {
      const turnId = str(rec(params.turn)?.id);
      if (turnId) enterTurn(m, turnId);
      if (!m.running) {
        m.running = true;
        m.turn = { startedAt: at, outputTokens: 0, thinkingTokens: 0 };
      }
      return;
    }
    case "turn/completed":
      applyTurnCompleted(draft, rec(params.turn) ?? {}, seq, at);
      return;
    case "item/started":
    case "item/completed": {
      const item = rec(params.item);
      const turnId = str(params.turnId) ?? m.turnId ?? "";
      if (item) {
        const when = num(item.startedAtMs) ?? at;
        applyItem(
          draft,
          turnId,
          item,
          method === "item/started" ? "started" : "completed",
          tag,
          when,
        );
      }
      return;
    }
    case "item/agentMessage/delta":
    case "item/plan/delta": {
      const delta = str(params.delta);
      const itemId = str(params.itemId);
      if (!delta || !itemId) return;
      appendText(draft, itemId, "text", delta, str(params.turnId) ?? m.turnId ?? "", tag, at);
      if (m.turn) {
        m.turn = { ...m.turn, outputTokens: m.turn.outputTokens + Math.ceil(delta.length / 4) };
      }
      return;
    }
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta": {
      const delta = str(params.delta);
      const itemId = str(params.itemId);
      if (!delta || !itemId) return;
      appendText(draft, itemId, "thinking", delta, str(params.turnId) ?? m.turnId ?? "", tag, at);
      if (m.turn) {
        const thinkingTokens = m.turn.thinkingTokens + Math.ceil(delta.length / 4);
        m.turn = { ...m.turn, thinkingTokens };
      }
      return;
    }
    case "item/reasoning/summaryPartAdded": {
      const itemId = str(params.itemId);
      if (itemId && m.blocks[itemId]) appendText(draft, itemId, "thinking", "\n\n", "", tag, at);
      return;
    }
    case "item/commandExecution/outputDelta": {
      const delta = str(params.delta);
      const itemId = str(params.itemId);
      if (!delta || !itemId || !m.tools[itemId]) return;
      draft.setTool(itemId, (t) => {
        const tool = t as ToolCall;
        const text = `${tool.result?.text ?? ""}${delta}`.slice(-MAX_LIVE_OUTPUT);
        return { ...tool, result: outputResult(text, false) };
      });
      return;
    }
    case "item/fileChange/patchUpdated": {
      const itemId = str(params.itemId);
      if (!itemId || !Array.isArray(params.changes)) return;
      const turnId = str(params.turnId) ?? m.turnId ?? "";
      const item = {
        type: "fileChange",
        id: itemId,
        changes: params.changes,
        status: "inProgress",
      };
      applyItem(draft, turnId, item, "started", tag, at);
      return;
    }
    case "thread/started":
      m.threadId ??= str(rec(params.thread)?.id);
      return;
    case "thread/name/updated":
      if (!params.threadId || params.threadId === m.threadId) {
        m.threadName = str(params.threadName) ?? m.threadName;
      }
      return;
    case "thread/settings/updated": {
      const settings = rec(params.threadSettings);
      if (settings) {
        applySettings(m, {
          model: settings.model,
          effort: settings.effort,
          sandbox: settings.sandboxPolicy,
        });
      }
      return;
    }
    case "thread/tokenUsage/updated": {
      const usage = rec(params.tokenUsage);
      const used = num(rec(usage?.last)?.totalTokens);
      if (used !== undefined) m.tokens = { used, window: num(usage?.modelContextWindow) };
      return;
    }
    case "thread/compacted":
      pushCompacted(draft, `n${seq}`, at);
      return;
    case "model/rerouted":
      m.model = str(params.toModel) ?? m.model;
      return;
    case "account/rateLimits/updated":
      m.rateLimits = mergeRateLimits(m.rateLimits, params.rateLimits);
      return;
    case "account/updated": {
      const mode = str(params.authMode);
      m.account = mode ? { type: mode } : null;
      if (mode) m.signedOut = false;
      return;
    }
    case "error": {
      const error = rec(params.error);
      if (params.willRetry === true) {
        if (m.turn) {
          const attempt = (m.turn.retry?.attempt ?? 0) + 1;
          m.turn = { ...m.turn, retry: { attempt } };
        }
        return;
      }
      pushError(draft, str(error?.message) ?? "error", `n${seq}`, at);
      return;
    }
    case "serverRequest/resolved": {
      const key = idKey(params.requestId);
      if (!key) return;
      if (m.requests[key]) {
        const { [key]: _resolved, ...rest } = m.requests;
        m.requests = rest;
      }
      m.permissions = m.permissions.filter((p) => p.requestId !== key);
      return;
    }
  }
}

function applyTurnCompleted(draft: CodexDraft, turn: Rec, seq: number, at: number | undefined) {
  const m = draft.next;
  const status = str(turn.status) ?? "completed";
  const turnId = str(turn.id);
  m.running = false;
  m.turn = null;
  m.streaming = null;
  m.interrupting = false;
  if (!turnId || turnId === m.turnId) m.turnId = undefined;
  // The turn's questions end with it.
  const ended = Object.entries(m.requests).filter(([, r]) => r.params.turnId === turnId);
  if (turnId && ended.length > 0) {
    const keys = new Set(ended.map(([key]) => key));
    m.requests = Object.fromEntries(Object.entries(m.requests).filter(([key]) => !keys.has(key)));
    m.permissions = m.permissions.filter((p) => !keys.has(p.requestId));
  }
  m.lastResult = {
    subtype: status,
    isError: status === "failed",
    durationMs: num(turn.durationMs),
    at,
  };
  if (status === "interrupted") {
    stopRunningTools(draft);
    draft.push({ kind: "notice", key: `n${seq}`, code: "interrupted", at });
  } else if (status === "failed") {
    stopRunningTools(draft);
    pushError(draft, str(rec(turn.error)?.message) ?? "failed", `n${seq}`, at);
  }
}

/** An error, once: the turn's failure repeats the error it was told. */
function pushError(draft: CodexDraft, detail: string, key: string, at: number | undefined) {
  const last = draft.next.items.at(-1);
  if (last?.kind === "notice" && last.code === "error" && last.detail === detail) return;
  draft.push({ kind: "notice", key, code: "error", detail, at });
}

/** A compaction, once: the thread and its item both tell it. */
function pushCompacted(draft: CodexDraft, key: string, at: number | undefined) {
  const last = draft.next.items.at(-1);
  if (last?.kind === "notice" && last.code === "compacted") return;
  draft.push({ kind: "notice", key, code: "compacted", at });
}

// ---------------------------------------------------------------------------
// Items: the turn's messages, thinking and tool calls.
// ---------------------------------------------------------------------------

function applyItem(
  draft: CodexDraft,
  turnId: string,
  item: Rec,
  phase: "started" | "completed",
  tag: string,
  at: number | undefined,
): void {
  const m = draft.next;
  const id = str(item.id);
  if (!id) return;
  switch (item.type) {
    case "userMessage": {
      if (m.items.some((i) => i.kind === "user" && i.uuid === id)) return;
      const clientId = str(item.clientId);
      if (clientId && takeUser(draft, `u-${clientId}`, id)) return;
      // A message the app sent, told without its client id: the oldest not yet told.
      const index = m.items.findIndex(
        (i) => i.kind === "user" && i.key.startsWith("u-") && i.uuid === undefined,
      );
      if (!clientId && index >= 0) {
        const sent = m.items[index] as UserItem;
        draft.replaceItem(index, { ...sent, state: "taken", uuid: id });
        return;
      }
      // Not one the app sent: an earlier turn's, another client's.
      const { text, images } = userInputOf(item.content);
      draft.push({ kind: "user", key: `u${tag}`, uuid: id, text, images, state: "taken", at });
      return;
    }
    case "agentMessage":
    case "plan": {
      const text = str(item.text) ?? "";
      if (phase === "completed" && text) setText(draft, id, "text", text, turnId, tag, at);
      return;
    }
    case "reasoning": {
      const text = reasoningText(item);
      if (phase === "completed" && text) setText(draft, id, "thinking", text, turnId, tag, at);
      return;
    }
    case "contextCompaction":
      if (phase === "completed") pushCompacted(draft, `n${tag}`, at);
      return;
    // A review (/review) is told as it starts; its findings come as Codex's
    // message after it ends, which tells what the review's end item does.
    case "enteredReviewMode":
      if (!m.items.some((i) => i.key === `r${id}`)) {
        draft.push({ kind: "notice", key: `r${id}`, code: "review", detail: str(item.review), at });
      }
      return;
  }
  const tools = toolsOf(item, id, phase);
  if (!tools) return;
  for (const tool of tools) {
    const known = m.tools[tool.id];
    draft.setTool(tool.id, (prev) => mergeTool(prev, tool));
    if (!known) addBlock(draft, turnId, { type: "tool", toolUseId: tool.id }, tag, at);
  }
}

/** A tool call as an item tells it: what it knew before stays when the item leaves it out. */
function mergeTool(prev: ToolCall | undefined, next: ToolCall): ToolCall {
  if (!prev) return next;
  return {
    ...next,
    // A call the user declined stays declined.
    status: prev.status === "denied" && next.status !== "done" ? "denied" : next.status,
    result: next.result ?? prev.result,
  };
}

/** Makes a turn the running one; its item ids are only known to be unique within it. */
function enterTurn(m: CodexModel, turnId: string): void {
  if (turnId !== m.turnId) m.blocks = {};
  m.turnId = turnId;
}

/** Marks a message the app sent as taken by the server; false when there is none. */
function takeUser(draft: CodexDraft, key: string, uuid: string | undefined): boolean {
  const items = draft.next.items;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind !== "user" || item.key !== key) continue;
    draft.replaceItem(i, { ...item, state: "taken", ...(uuid ? { uuid } : {}) });
    return true;
  }
  return false;
}

/** The turn's assistant message to add to: the last item, or a new one. */
function assistantIndex(draft: CodexDraft, turnId: string, tag: string, at: number | undefined) {
  const items = draft.next.items;
  const last = items.at(-1);
  if (last?.kind === "assistant" && last.messageId === turnId) return items.length - 1;
  draft.push({ kind: "assistant", key: `a${tag}`, messageId: turnId, blocks: [], at });
  return draft.next.items.length - 1;
}

function addBlock(
  draft: CodexDraft,
  turnId: string,
  block: AssistantBlock,
  tag: string,
  at: number | undefined,
): { key: string; index: number } {
  const index = assistantIndex(draft, turnId, tag, at);
  const item = draft.next.items[index] as AssistantItem;
  draft.replaceItem(index, { ...item, blocks: [...item.blocks, block] });
  return { key: item.key, index: item.blocks.length };
}

/** The text block an item streams into, made on its first text. */
function textBlock(
  draft: CodexDraft,
  itemId: string,
  type: "text" | "thinking",
  turnId: string,
  tag: string,
  at: number | undefined,
): { index: number; item: AssistantItem; block: number } | null {
  const m = draft.next;
  let where = m.blocks[itemId];
  if (!where) {
    if (!turnId) return null;
    where = addBlock(draft, turnId, { type, text: "" }, tag, at);
    m.blocks = { ...m.blocks, [itemId]: where };
  }
  for (let i = m.items.length - 1; i >= 0; i--) {
    const item = m.items[i];
    if (item.kind === "assistant" && item.key === where.key) {
      return { index: i, item, block: where.index };
    }
  }
  return null;
}

function updateText(
  draft: CodexDraft,
  itemId: string,
  type: "text" | "thinking",
  turnId: string,
  tag: string,
  at: number | undefined,
  update: (text: string) => string,
): void {
  const found = textBlock(draft, itemId, type, turnId, tag, at);
  if (!found) return;
  const blocks = [...found.item.blocks];
  const block = blocks[found.block];
  if (!block || block.type === "tool") return;
  blocks[found.block] = { ...block, text: update(block.text) };
  draft.replaceItem(found.index, { ...found.item, blocks });
}

function appendText(
  draft: CodexDraft,
  itemId: string,
  type: "text" | "thinking",
  delta: string,
  turnId: string,
  tag: string,
  at: number | undefined,
): void {
  updateText(draft, itemId, type, turnId, tag, at, (text) => text + delta);
}

function setText(
  draft: CodexDraft,
  itemId: string,
  type: "text" | "thinking",
  text: string,
  turnId: string,
  tag: string,
  at: number | undefined,
): void {
  updateText(draft, itemId, type, turnId, tag, at, () => text);
}

function reasoningText(item: Rec): string {
  const parts = (value: unknown) =>
    Array.isArray(value) ? value.filter((p): p is string => typeof p === "string" && p !== "") : [];
  const summary = parts(item.summary);
  return (summary.length > 0 ? summary : parts(item.content)).join("\n\n");
}

/** The tool calls an item is: one for most, one for each file a patch changes. */
function toolsOf(item: Rec, id: string, phase: "started" | "completed"): ToolCall[] | null {
  const base = { parentToolUseId: null, status: callStatus(item.status, phase) };
  switch (item.type) {
    case "commandExecution": {
      const output = str(item.aggregatedOutput);
      const exitCode = num(item.exitCode);
      const failed = base.status === "done" && exitCode !== undefined && exitCode !== 0;
      return [
        {
          ...base,
          id,
          name: "Bash",
          displayName: shellName(str(item.command) ?? ""),
          input: { command: shownCommand(str(item.command) ?? ""), cwd: str(item.cwd) },
          status: failed ? "error" : base.status,
          ...(output !== undefined || phase === "completed"
            ? { result: outputResult(output ?? "", failed || base.status === "error") }
            : {}),
        },
      ];
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      return changes.flatMap((raw, i) => {
        const change = rec(raw);
        const path = str(change?.path);
        if (!change || !path) return [];
        const kind = str(rec(change.kind)?.type);
        // A moved file's row names where it is now, and where it was.
        const movedTo = kind === "update" ? str(rec(change.kind)?.move_path) : undefined;
        const diff = str(change.diff) ?? "";
        const structuredPatch = hunksOf(movedTo ? withoutMoveTail(diff) : diff, kind);
        return [
          {
            ...base,
            id: `${id}:${i}`,
            name: kind === "add" ? "Write" : kind === "delete" ? "Delete" : "Edit",
            input: movedTo ? { file_path: movedTo, moved_from: path } : { file_path: path },
            result: {
              text: "",
              isError: base.status === "error",
              structured: { structuredPatch, ...(kind === "add" ? { type: "create" } : {}) },
              images: [],
            },
          },
        ];
      });
    }
    case "mcpToolCall": {
      const error = str(rec(item.error)?.message);
      const content = rec(item.result)?.content;
      return [
        {
          ...base,
          id,
          name: `mcp__${str(item.server) ?? ""}__${str(item.tool) ?? ""}`,
          input: item.arguments ?? {},
          ...(error !== undefined || content !== undefined
            ? {
                result: {
                  text: error ?? contentText(content),
                  isError: error !== undefined,
                  images: [],
                },
              }
            : {}),
        },
      ];
    }
    case "dynamicToolCall": {
      const content = item.contentItems;
      return [
        {
          ...base,
          id,
          name: str(item.tool) ?? "tool",
          input: item.arguments ?? {},
          ...(Array.isArray(content)
            ? {
                result: {
                  text: contentText(content),
                  isError: item.success === false,
                  images: [],
                },
              }
            : {}),
        },
      ];
    }
    case "webSearch":
      return [{ ...base, id, name: "WebSearch", input: { query: str(item.query) ?? "" } }];
    case "imageView":
      return [{ ...base, id, name: "ViewImage", input: { file_path: str(item.path) ?? "" } }];
    case "collabAgentToolCall":
      return [
        {
          ...base,
          id,
          name: str(item.tool) ?? "agent",
          input: { prompt: str(item.prompt) ?? "" },
        },
      ];
  }
  return null;
}

function callStatus(status: unknown, phase: "started" | "completed"): ToolCall["status"] {
  switch (status) {
    case "inProgress":
      return phase === "completed" ? "done" : "running";
    case "completed":
      return "done";
    case "failed":
      return "error";
    case "declined":
      return "denied";
  }
  return phase === "completed" ? "done" : "running";
}

function outputResult(text: string, isError: boolean) {
  return { text, isError, structured: { stdout: text }, images: [] as ImageBlock[] };
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((raw) => {
      const part = rec(raw);
      return str(part?.text) ?? "";
    })
    .filter((text) => text !== "")
    .join("\n");
}

/** A shell that runs the one script it is given, as Codex wraps a command in. */
const SHELL_SCRIPT = /^(?:\S*\/)?(?:bash|zsh|sh) -l?c (.+)$/s;

/**
 * PowerShell given one script, as Codex wraps a command in on Windows:
 * `"C:\\…\\powershell.exe" -Command '…'`, its path quoted as a shell word.
 */
const POWERSHELL_SCRIPT =
  /^(?:"[^"]*[\\/]|[^\s"]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"? -Command (.+)$/is;

/**
 * The command a row shows: the script, without the `bash -lc '…'` or the
 * PowerShell Codex runs it in. Anything else is shown as it is.
 */
export function shownCommand(command: string): string {
  const script = (SHELL_SCRIPT.exec(command) ?? POWERSHELL_SCRIPT.exec(command))?.[1];
  return (script === undefined ? null : shellWord(script)) ?? command;
}

/**
 * The shell a command runs in, as its row names it. Rows of every shell are
 * drawn as Claude's Bash rows are, so only the name tells them apart.
 */
export function shellName(command: string): "PowerShell" | "Bash" | "Shell" {
  if (POWERSHELL_SCRIPT.test(command)) return "PowerShell";
  if (SHELL_SCRIPT.test(command)) return "Bash";
  return "Shell";
}

/** A shell-quoted string read as the one word it is; null when it is not one word. */
function shellWord(text: string): string | null {
  let word = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return null;
      word += text.slice(i + 1, end);
      i = end + 1;
    } else if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "$" || text[i] === "`") return null;
        if (text[i] === "\\" && '"\\$`\n'.includes(text[i + 1] ?? "")) i++;
        word += text[i++];
      }
      if (i >= text.length) return null;
      i++;
    } else if (ch === "\\") {
      word += text[i + 1] ?? "";
      i += 2;
    } else if (/[\s;&|<>()$`*?[\]{}~#]/.test(ch)) {
      return null;
    } else {
      word += ch;
      i++;
    }
  }
  return word;
}

/**
 * A change's patch as the rows show one: a unified diff's hunks, or a new
 * or deleted file's lines all added or all removed.
 */
export function hunksOf(diff: string, kind: string | undefined): { lines: string[] }[] {
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return [];
  if (!lines.some((line) => line.startsWith("@@"))) {
    const mark = kind === "add" ? "+" : kind === "delete" ? "-" : "";
    return [{ lines: mark ? lines.map((line) => `${mark}${line}`) : lines }];
  }
  const hunks: { lines: string[] }[] = [];
  for (const line of lines) {
    if (line.startsWith("@@")) {
      hunks.push({ lines: [] });
      continue;
    }
    // The file headers before the first hunk, and "\ No newline at end of file".
    if (!line.startsWith("\\")) hunks.at(-1)?.lines.push(line);
  }
  return hunks;
}

/**
 * A moved file's diff without the line Codex ends it with, "Moved to:" and
 * the new path after a blank line. No line of a unified diff starts so.
 */
function withoutMoveTail(diff: string): string {
  return diff.replace(/\n\nMoved to: [^\n]*$/, "");
}

/**
 * The originals of the files a list shows, by the list's own paths. A
 * Windows path matches whichever way its separators and case are written.
 */
export function originalsFor(
  originals: Readonly<Record<string, string | null>>,
  files: readonly string[],
): Record<string, string | null> {
  const known = new Map<string, string | null>();
  for (const [path, before] of Object.entries(originals)) known.set(pathKey(path), before);
  const found: Record<string, string | null> = {};
  for (const file of files) {
    const before = known.get(pathKey(file));
    if (before !== undefined) found[file] = before;
  }
  return found;
}

/** A path as the file it names: a Windows one with `/`, in lower case. */
function pathKey(path: string): string {
  return /^[A-Za-z]:[\\/]/.test(path) ? path.replace(/\\/g, "/").toLowerCase() : path;
}

/** The file a patch's row changes, as an approval names it: "old → new" for a move. */
function changedPathOf(tool: ToolCall): string {
  const input = rec(tool.input);
  const path = str(input?.file_path) ?? "";
  const from = str(input?.moved_from);
  return from ? `${from} → ${path}` : path;
}

/** The ids of the tool calls an item is: itself, or one for each file it changes. */
function toolIdsOf(m: CodexModel, itemId: string): string[] {
  return Object.keys(m.tools).filter((id) => id === itemId || id.startsWith(`${itemId}:`));
}

// ---------------------------------------------------------------------------
// The server's requests: approvals and questions, shown as permission cards.
// ---------------------------------------------------------------------------

/** What allowing for the session adds, for the card to say. */
const SESSION_SUGGESTION = { type: "session" };

function applyServerRequest(draft: CodexDraft, key: string, method: string, params: Rec): void {
  const m = draft.next;
  m.requests = { ...m.requests, [key]: { method, params } };
  const permission = permissionOf(m, key, method, params);
  if (permission) {
    m.permissions = [...m.permissions.filter((p) => p.requestId !== key), permission];
  }
}

function permissionOf(
  m: CodexModel,
  key: string,
  method: string,
  params: Rec,
): PermissionRequest | null {
  const itemId = str(params.itemId);
  const reason = str(params.reason);
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const tool = itemId ? m.tools[itemId] : undefined;
      const known = rec(tool?.input);
      const command = str(params.command);
      return {
        requestId: key,
        toolName: "Bash",
        displayName: command ? shellName(command) : (tool?.displayName ?? shellName("")),
        input: {
          command: shownCommand(command ?? "") || (str(known?.command) ?? ""),
          cwd: str(params.cwd) ?? str(known?.cwd),
        },
        description: reason,
        suggestions: [SESSION_SUGGESTION],
        toolUseId: itemId,
      };
    }
    case "item/fileChange/requestApproval": {
      const tools = itemId ? toolIdsOf(m, itemId).map((id) => m.tools[id]) : [];
      const paths = tools.map(changedPathOf).filter(Boolean);
      const structuredPatch = tools.flatMap((t) => {
        const hunks = (rec(t.result?.structured)?.structuredPatch ?? []) as { lines: string[] }[];
        const moved = str(rec(t.input)?.moved_from) !== undefined;
        // More than one file, or a moved one: each one's lines start with its path.
        if (tools.length === 1 && !moved) return hunks;
        if (hunks.length === 0) return moved ? [{ lines: [changedPathOf(t)] }] : [];
        return [{ lines: [changedPathOf(t), ...hunks[0].lines] }, ...hunks.slice(1)];
      });
      const input = { file_path: paths.join(", ") };
      return {
        requestId: key,
        toolName: "Edit",
        input,
        description: reason,
        suggestions: [SESSION_SUGGESTION],
        toolUseId: tools[0]?.id,
        preview: {
          id: itemId ?? key,
          name: "Edit",
          input,
          status: "running",
          parentToolUseId: null,
          result: { text: "", isError: false, structured: { structuredPatch }, images: [] },
        },
      };
    }
    case "item/permissions/requestApproval":
      return {
        requestId: key,
        toolName: "Permissions",
        input: rec(params.permissions) ?? {},
        description: reason,
        decisionReason: describePermissions(rec(params.permissions)),
        suggestions: [SESSION_SUGGESTION],
      };
    case "item/tool/requestUserInput": {
      const questions = Array.isArray(params.questions) ? params.questions : [];
      return {
        requestId: key,
        toolName: "AskUserQuestion",
        input: {
          questions: questions.flatMap((raw) => {
            const q = rec(raw);
            const question = str(q?.question);
            if (!q || !question) return [];
            const options = Array.isArray(q.options) ? q.options : [];
            return [
              {
                question,
                header: str(q.header),
                multiSelect: false,
                options: options.flatMap((o) => {
                  const label = str(rec(o)?.label);
                  return label ? [{ label, description: str(rec(o)?.description) }] : [];
                }),
              },
            ];
          }),
        },
        suggestions: [],
      };
    }
  }
  return null;
}

/** What more access a turn asks for, in a line: the network, folders to write. */
function describePermissions(permissions: Rec | null): string | undefined {
  if (!permissions) return undefined;
  const parts: string[] = [];
  if (permissions.network) parts.push("network");
  const fs = rec(permissions.fileSystem);
  if (fs) {
    for (const [access, paths] of Object.entries(fs)) {
      if (Array.isArray(paths) && paths.length > 0) parts.push(`${access}: ${paths.join(", ")}`);
    }
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

// ---------------------------------------------------------------------------
// Small readers.
// ---------------------------------------------------------------------------

/** A message's input as a bubble shows it: text, mentions as @paths, images. */
function userInputOf(input: unknown): Pick<UserItem, "text" | "images"> {
  const texts: string[] = [];
  const mentions: string[] = [];
  const images: ImageBlock[] = [];
  for (const raw of Array.isArray(input) ? input : []) {
    const part = rec(raw);
    switch (part?.type) {
      case "text":
        texts.push(str(part.text) ?? "");
        break;
      case "image": {
        const image = dataImage(str(part.url));
        if (image) images.push(image);
        break;
      }
      case "localImage":
      case "mention": {
        const path = str(part.path);
        if (path) mentions.push(fileMention(path));
        break;
      }
    }
  }
  const text = texts.join("\n");
  if (mentions.length === 0) return { text, images };
  return { text: text ? `${text}\n\n${mentions.join(" ")}` : mentions.join(" "), images };
}

function dataImage(url: string | undefined): ImageBlock | null {
  const match = url ? /^data:([^;,]+);base64,(.*)$/s.exec(url) : null;
  return match ? { mediaType: match[1], data: match[2] } : null;
}

/** The models the picker lists, as the server describes them; hidden ones are left out. */
function modelsOf(data: unknown): ModelInfo[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((raw) => {
    const model = rec(raw);
    const value = str(model?.model) ?? str(model?.id);
    if (!model || !value || model.hidden === true) return [];
    const efforts = Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.flatMap((e) => {
          const effort = str(rec(e)?.reasoningEffort);
          return effort ? [effort] : [];
        })
      : [];
    return [
      {
        value,
        displayName: str(model.displayName),
        description: str(model.description),
        supportedEffortLevels: efforts,
      },
    ];
  });
}

function limitWindowOf(raw: unknown): CodexLimitWindow | undefined {
  const window = rec(raw);
  const usedPercent = num(window?.usedPercent);
  if (usedPercent === undefined) return undefined;
  return {
    usedPercent,
    ...(num(window?.windowDurationMins) !== undefined
      ? { windowMins: num(window?.windowDurationMins) }
      : {}),
    ...(num(window?.resetsAt) !== undefined ? { resetsAt: num(window?.resetsAt) } : {}),
  };
}

/** A RateLimitSnapshot's windows; undefined when it has none. */
function rateLimitsOf(raw: unknown): CodexRateLimits | undefined {
  const snapshot = rec(raw);
  const primary = limitWindowOf(snapshot?.primary);
  const secondary = limitWindowOf(snapshot?.secondary);
  if (!primary && !secondary) return undefined;
  const limitId = str(snapshot?.limitId);
  return {
    ...(limitId ? { limitId } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  };
}

/**
 * A rolling update laid over what the tab knew: it may carry one window
 * only, and one it leaves out still holds. Another bucket's update (a
 * different limitId) is not the tab's.
 */
function mergeRateLimits(
  prev: CodexRateLimits | undefined,
  raw: unknown,
): CodexRateLimits | undefined {
  const next = rateLimitsOf(raw);
  if (!next) return prev;
  if (prev?.limitId && next.limitId && prev.limitId !== next.limitId) return prev;
  const primary = next.primary ?? prev?.primary;
  const secondary = next.secondary ?? prev?.secondary;
  const limitId = prev?.limitId ?? next.limitId;
  return {
    ...(limitId ? { limitId } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  };
}

/** An account as the tab keeps it: its kind, never who it is. */
function accountOf(raw: unknown): { type: string } | null {
  const account = rec(raw);
  return account ? { type: str(account.type) ?? "unknown" } : null;
}
