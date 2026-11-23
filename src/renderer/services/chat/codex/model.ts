import { codexErrorStatus, codexRetryCount, codexTurnFailure, retryReasonOf } from "../api-errors";
import { fileMention } from "../composer-input";
import { CODEX_GOAL_STATUSES, type CodexGoal, type CodexGoalStatus } from "../goal";
import {
  type AssistantBlock,
  type AssistantItem,
  applySys,
  type ChatItem,
  type ChatLine,
  type ChatModel,
  clearInterrupt,
  Draft,
  emptyModel,
  finishSubmittedTurn,
  type ImageBlock,
  type ModelInfo,
  noteTurnActivity,
  num,
  type PermissionRequest,
  rec,
  stopRunningTasks,
  stopRunningTools,
  str,
  type TaskInfo,
  type ToolCall,
  type UserItem,
} from "../model";
import { commandLabel, WAITED_CALL_DELAY_MS } from "../running";
import {
  type CodexCollaborationMode,
  type CodexCollaborationSettings,
  collaborationPresetsOf,
  collaborationSettingsOf,
} from "./collaboration";
import { CODEX_INIT_PROMPT, type CodexMcpServer } from "./commands";
import {
  appendCodexForkPage,
  type CodexForkPages,
  codexForkPrefix,
  codexForkSourceStatus,
  codexHistoryAvailable,
  codexServerVersion,
  codexTurnIds,
  emptyCodexForkPages,
  validCodexFork,
} from "./history";
import { matchesProfileForkSettings } from "./profile-fork";

type Rec = Record<string, unknown>;

export type CodexMode = "readOnly" | "auto" | "fullAccess";

export const CODEX_MODES: readonly CodexMode[] = ["readOnly", "auto", "fullAccess"];

export interface CodexLimitWindow {
  usedPercent: number;
  windowMins?: number;
  resetsAt?: number;
}

export interface CodexRateLimits {
  limitId?: string;
  primary?: CodexLimitWindow;
  secondary?: CodexLimitWindow;
}

export interface CodexServerRequest {
  method: string;
  params: Rec;
}

interface LiveCommand {
  turnId: string;
  startedAt?: number;
  canContinue: boolean;
}

export interface CodexModel extends ChatModel {
  logSeqOffset?: number;
  sandboxMode?: CodexMode | null;
  threadId?: string;
  appServerVersion?: string;
  canonicalCwd?: string;
  forkSource?:
    | { threadId: string; legacyTurns: string[] }
    | { threadId: string; pages: CodexForkPages };
  nativeTranscripts?: Record<string, ChatItem[]>;
  turnId?: string;
  toolCompletedSeq?: number;
  liveCommands?: Record<string, LiveCommand>;
  account?: { type: string } | null;
  signedOut?: boolean;
  tokens?: { used: number; window?: number };
  rateLimits?: CodexRateLimits;
  plan?: { content: string; status: "pending" | "in_progress" | "completed" }[];
  mcpServers?: CodexMcpServer[];
  mcpLogin?: { seq: number; name: string; success: boolean; error?: string };
  threadName?: string;
  serviceTier?: string | null;
  collaborationPresets?: ReturnType<typeof collaborationPresetsOf>;
  collaborationMode?: CodexCollaborationMode;
  collaborationSettings?: Partial<Record<CodexCollaborationMode, CodexCollaborationSettings>>;
  reviewTurn?: string;
  threadGoal?: CodexGoal | null;
  blocks: Record<string, { key: string; index: number }>;
  requests: Record<string, CodexServerRequest>;
  originals: Record<string, string | null>;
}

export function emptyCodexModel(): CodexModel {
  return { ...emptyModel(), blocks: {}, requests: {}, originals: {} };
}

export function loseCodexLog(prev: CodexModel): CodexModel {
  const draft = new Draft<CodexModel>({
    ...prev,
    logSeqOffset: (prev.logSeqOffset ?? 0) + prev.lastSeq,
    lastSeq: 0,
    process: "exited",
    running: false,
    turn: null,
    turnId: undefined,
    toolCompletedSeq: undefined,
    interrupting: false,
    interruptRequestId: undefined,
    streaming: null,
    permissions: [],
    requests: {},
    outgoing: {},
    blocks: {},
    forkSource: undefined,
    reviewTurn: undefined,
    mcpServers: undefined,
    mcpLogin: undefined,
  });
  settleCommands(draft, undefined);
  stopRunningTools(draft);
  stopRunningTasks(draft, undefined);
  return draft.next;
}

export function nextThreadModel(prev: CodexModel): CodexModel {
  const {
    lastSeq,
    init,
    version,
    appServerVersion,
    canonicalCwd,
    account,
    signedOut,
    rateLimits,
    collaborationPresets,
  } = prev;
  return {
    ...emptyCodexModel(),
    lastSeq,
    init,
    version,
    appServerVersion,
    canonicalCwd,
    collaborationPresets,
    account,
    signedOut,
    rateLimits,
  };
}

export function idKey(id: unknown): string | null {
  return typeof id === "string" || typeof id === "number" ? JSON.stringify(id) : null;
}

const QUIET_REQUESTS = new Set([
  "model/list",
  "account/read",
  "account/rateLimits/read",
  "fuzzyFileSearch",
  "thread/goal/get",
  "thread/list",
  "thread/read",
  "thread/turns/list",
  "thread/fork",
  "thread/delete",
  "thread/unsubscribe",
  "mcpServerStatus/list",
  "mcpServer/oauth/login",
  "config/mcpServer/reload",
  "config/read",
  "configRequirements/read",
  "collaborationMode/list",
  "thread/unsubscribe",
  "config/batchWrite",
]);

const MAX_LIVE_OUTPUT = 100_000;

export function applyCodexLine(
  prev: CodexModel,
  line: ChatLine,
  now: number = Date.now(),
  installedVersion?: string | null,
): CodexModel {
  if (line.seq <= prev.lastSeq) return prev;
  const draft = Object.assign(new Draft(prev), { installedVersion });
  draft.next.lastSeq = line.seq;
  const message = rec(line.message);
  if (!message) return draft.next;
  const at = line.at ?? (line.replay ? undefined : now);
  const keySeq = (prev.logSeqOffset ?? 0) + line.seq;
  if (line.dir === "sys" && message.event === "snapshot") {
    const path = str(message.path);
    const before = message.before;
    if (path && (typeof before === "string" || before === null)) {
      draft.next.originals = { ...draft.next.originals, [path]: before };
    }
  } else if (line.dir === "sys") {
    if (message.event === "exit" || message.event === "start") settleCommands(draft, at);
    applySys(draft, message, keySeq, at);
    if (message.event === "start") {
      draft.next.canonicalCwd = str(message.canonicalCwd);
      if (message.connectionChanged === true) {
        draft.next.tokens = undefined;
        draft.next.account = undefined;
      }
    }
    if (message.event === "start" || message.event === "exit") {
      draft.next.requests = {};
      draft.next.sandboxMode = undefined;
      draft.next.blocks = {};
      draft.next.forkSource = undefined;
      draft.next.turnId = undefined;
      draft.next.toolCompletedSeq = undefined;
      draft.next.mcpServers = undefined;
      draft.next.mcpLogin = undefined;
    }
  } else if (line.dir === "in") applyIn(draft, message, keySeq, at);
  else applyOut(draft, message, line.seq, at);
  return draft.next;
}

export function applyCodexLines(
  prev: CodexModel,
  lines: readonly ChatLine[],
  now?: number,
  installedVersion?: string | null,
): CodexModel {
  let model = prev;
  for (const line of lines) model = applyCodexLine(model, line, now, installedVersion);
  return model;
}

type CodexDraft = Draft<CodexModel> & { readonly installedVersion?: string | null };

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
        const clientId = str(params.clientUserMessageId);
        if (!clientId?.startsWith("peer-")) {
          const { text, images } = userInputOf(params.input);
          draft.push({ kind: "user", key: userKey(params, seq), text, images, state: "sent", at });
        }
        if (method === "turn/start") {
          applySettings(m, {
            model: params.model,
            effort: params.effort,
            sandbox: params.sandboxPolicy,
          });
          if (!m.running) {
            m.running = true;
            m.turn = { startedAt: at, outputTokens: 0, thinkingTokens: 0 };
            noteTurnActivity(m, at);
          }
        }
        return;
      }
      case "turn/interrupt":
        if (m.running && key && params.turnId === m.turnId) {
          m.interrupting = true;
          m.interruptRequestId = key;
        }
        return;
    }
    return;
  }
  if (!key || !m.requests[key]) return;
  const { [key]: request, ...rest } = m.requests;
  m.requests = rest;
  m.permissions = m.permissions.filter((p) => p.requestId !== key);
  noteTurnActivity(m, at);
  const decision = rec(message.result)?.decision;
  const itemId = str(request.params.itemId);
  if ((decision === "decline" || decision === "cancel") && itemId) {
    for (const id of toolIdsOf(m, itemId)) {
      draft.setTool(id, (t) => ({ ...(t as ToolCall), status: "denied" }));
    }
  }
}

function userKey(params: Rec, seq: number): string {
  const clientId = str(params.clientUserMessageId);
  return clientId ? `u-${clientId}` : `u${seq}`;
}

function applyOut(draft: CodexDraft, message: Rec, seq: number, at: number | undefined): void {
  const method = str(message.method);
  const key = idKey(message.id);
  const params = rec(message.params) ?? {};
  if (method && key) applyServerRequest(draft, key, method, params);
  else if (method) applyNotification(draft, method, params, seq, at);
  else if (key) applyResponse(draft, key, message, (draft.next.logSeqOffset ?? 0) + seq, at);
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
    if (sent.subtype === "turn/interrupt") clearInterrupt(m, key);
    if (
      sent.request.threadId === m.forkSource?.threadId &&
      (sent.subtype === "thread/turns/list" ||
        sent.subtype === "thread/fork" ||
        (sent.subtype === "thread/read" && sent.request.includeTurns === false))
    ) {
      m.forkSource = undefined;
    }
    if (QUIET_REQUESTS.has(sent.subtype)) return;
    if (sent.subtype === "turn/start" || sent.subtype === "turn/steer") {
      const clientId = str(sent.request.clientUserMessageId);
      const index = m.items.findIndex(
        (item) => item.kind === "user" && item.state === "sent" && item.key === `u-${clientId}`,
      );
      if (clientId && index >= 0) draft.removeItem(index);
      if (sent.subtype === "turn/steer") return;
    }
    if (sent.subtype === "thread/resume") {
      if (!m.items.some((i) => i.kind !== "notice")) return;
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
      clearInterrupt(m);
    }
    const detail = str(error.message) ?? sent.subtype;
    draft.push({ kind: "notice", key: `n${seq}`, code: "error", detail, at });
    return;
  }
  const result = rec(message.result) ?? {};
  switch (sent.subtype) {
    case "initialize":
      m.collaborationMode = undefined;
      m.collaborationSettings = undefined;
      m.collaborationPresets = undefined;
      m.appServerVersion = str(result.userAgent)?.match(/^[^/]+\/([\d.]+)\b/)?.[1];
      return;
    case "thread/start":
    case "thread/resume": {
      if (sent.request.ephemeral === true) return;
      const intended = sent.subtype === "thread/resume" ? str(sent.request.threadId) : undefined;
      if (intended && str(rec(result.thread)?.id) !== intended) return;
      applyThread(draft, result, seq);
      return;
    }
    case "thread/list":
      if (
        typeof sent.request.parentThreadId === "string" &&
        sent.request.parentThreadId === m.threadId &&
        Array.isArray(result.data)
      ) {
        for (const raw of result.data) {
          const child = rec(raw);
          const id = str(child?.id);
          if (child && id && id !== m.threadId && parentThreadOf(child) === m.threadId) {
            applyNativeAgent(m, id, child, undefined, undefined, at);
          }
        }
      }
      return;
    case "thread/read": {
      const thread = rec(result.thread);
      const id = str(thread?.id);
      if (
        id &&
        thread &&
        id === sent.request.threadId &&
        sent.request.includeTurns === true &&
        m.tasks[id]?.type === "codex_subagent"
      ) {
        applyNativeAgent(m, id, thread, undefined, undefined, at);
        applyAgentTranscript(draft, id, thread, seq);
      } else if (
        sent.request.includeTurns === false &&
        (!m.threadId || sent.request.threadId === m.threadId)
      ) {
        const sourceId = str(sent.request.threadId);
        const status = sourceId && codexForkSourceStatus(sourceId, result);
        m.forkSource =
          sourceId && status && status !== "active"
            ? { threadId: sourceId, pages: emptyCodexForkPages() }
            : undefined;
      } else if (
        id &&
        id === sent.request.threadId &&
        sent.request.includeTurns === true &&
        (!m.threadId || id === m.threadId)
      ) {
        const turns = codexTurnIds(thread);
        m.forkSource = turns && { threadId: id, legacyTurns: turns };
      }
      return;
    }
    case "thread/turns/list": {
      const source = m.forkSource;
      if (
        source &&
        "pages" in source &&
        source.threadId === sent.request.threadId &&
        sent.request.sortDirection === "asc" &&
        sent.request.itemsView === "notLoaded"
      ) {
        const pages = appendCodexForkPage(source.pages, sent.request.cursor, result);
        m.forkSource = pages && { threadId: source.threadId, pages };
      }
      return;
    }
    case "thread/fork": {
      const threadId = str(sent.request.threadId);
      if (!threadId) return;
      const fork = {
        threadId,
        beforeTurnId: str(sent.request.beforeTurnId),
        lastTurnId: str(sent.request.lastTurnId),
      };
      const source = m.forkSource;
      m.forkSource = undefined;
      if (
        !matchesProfileForkSettings(sent.request, result) ||
        (typeof sent.request.modelProvider === "string" &&
          result.modelProvider !== sent.request.modelProvider) ||
        !validCodexFork(
          fork,
          result,
          codexForkPrefix(
            fork,
            source?.threadId === threadId
              ? "pages" in source
                ? source.pages.turns
                : source.legacyTurns
              : undefined,
          ),
        )
      )
        return;
      if (m.threadId === threadId && typeof sent.request.modelProvider !== "string") {
        const fresh = nextThreadModel(m);
        Object.assign(m, fresh, {
          process: m.process,
          outgoing: m.outgoing,
          originals: m.originals,
          permissionMode: m.permissionMode,
          cwd: m.cwd,
          threadId: undefined,
          threadName: undefined,
          threadGoal: undefined,
          turnId: undefined,
          tokens: undefined,
          lastResult: undefined,
          reviewTurn: undefined,
          nativeTranscripts: undefined,
          plan: undefined,
          interrupting: false,
          interruptRequestId: undefined,
        });
      }
      applyThread(draft, result, seq);
      return;
    }
    case "turn/start":
    case "turn/steer": {
      const turnId = str(rec(result.turn)?.id) ?? str(result.turnId);
      if (sent.subtype === "turn/start") {
        if (turnId && m.running) enterTurn(m, turnId);
        if (sent.request.threadId === m.threadId) {
          if (sent.request.sandboxPolicy !== undefined) {
            m.sandboxMode = modeOf(sent.request.sandboxPolicy) ?? null;
            m.confirmedPermissionMode = confirmedModeOf(
              sent.request.sandboxPolicy,
              sent.request.approvalPolicy,
            );
          }
          rememberCollaborationEffort(m, sent.request.effort);
        }
      } else if (m.running && (turnId ?? sent.request.expectedTurnId) === m.turnId) {
        noteTurnActivity(m, at);
      }
      const clientId = str(sent.request.clientUserMessageId);
      if (clientId) {
        const key = `u-${clientId}`;
        const found = takeUser(draft, key, undefined, turnId);
        if (!found && clientId.startsWith("peer-")) {
          const { text, images } = userInputOf(sent.request.input);
          draft.push({ kind: "user", key, text, images, state: "taken", turnId, at });
        }
      }
      return;
    }
    case "collaborationMode/list":
      m.collaborationPresets = collaborationPresetsOf(result.data);
      return;
    case "thread/settings/update":
      if (sent.request.threadId === m.threadId) {
        if (sent.request.collaborationMode) applyCollaboration(m, sent.request.collaborationMode);
        else rememberCollaborationEffort(m, sent.request.effort);
      }
      return;
    case "model/list":
      m.init = { commands: [], models: codexModelsOf(result.data), remoteControl: false };
      return;
    case "account/read":
      m.account = accountOf(result.account);
      m.signedOut = m.account === null && result.requiresOpenaiAuth === true;
      return;
    case "account/rateLimits/read":
      m.rateLimits = rateLimitsOf(result.rateLimits) ?? m.rateLimits;
      return;
    case "thread/goal/get":
    case "thread/goal/set":
      if (!sent.request.threadId || sent.request.threadId === m.threadId) {
        m.threadGoal = nextGoal(m.threadGoal, result.goal, at);
      }
      return;
    case "thread/goal/clear":
      if (!sent.request.threadId || sent.request.threadId === m.threadId) m.threadGoal = null;
      return;
  }
}

function parentThreadOf(thread: Rec): string | undefined {
  const spawn = rec(rec(rec(thread.source)?.subAgent)?.thread_spawn);
  return str(thread.parentThreadId) ?? str(spawn?.parent_thread_id);
}

function nativeTurnEnd(status: unknown): string | undefined {
  switch (status) {
    case "completed":
    case "failed":
      return status;
    case "interrupted":
      return "stopped";
  }
}

export const THREAD_STATUS_CHANGED = "thread/status/changed";

export function isThreadStatusChanged(method: string | undefined): boolean {
  return method === THREAD_STATUS_CHANGED || method === "thread/statusChanged";
}

function applyNativeAgentNotification(
  m: CodexModel,
  id: string,
  method: string,
  params: Rec,
  at: number | undefined,
): void {
  const task = m.tasks[id];
  if (task?.type !== "codex_subagent") return;
  if (isThreadStatusChanged(method)) {
    if (!["active", "idle", "systemError"].includes(String(rec(params.status)?.type))) return;
    applyNativeAgent(m, id, { status: params.status }, undefined, undefined, at);
    return;
  }
  let status: string | undefined;
  switch (method) {
    case "thread/closed":
      if (task.status === "running") status = "stopped";
      break;
    case "turn/started":
      status = "running";
      break;
    case "turn/completed":
      status = nativeTurnEnd(rec(params.turn)?.status);
      break;
  }
  if (status) applyNativeAgent(m, id, {}, status, undefined, at);
}

function applyNativeAgent(
  m: CodexModel,
  id: string,
  metadata: Rec = {},
  status?: string,
  prompt?: string,
  at?: number,
): void {
  const before = m.tasks[id];
  const kind = str(rec(metadata.status)?.type);
  const lastTurn = Array.isArray(metadata.turns) ? rec(metadata.turns.at(-1)) : undefined;
  const previous = before?.status;
  const nextStatus =
    status ??
    (kind === "active"
      ? "running"
      : kind === "systemError"
        ? "failed"
        : (nativeTurnEnd(lastTurn?.status) ??
          (kind === "idle" && (!previous || previous === "running") ? "completed" : previous) ??
          "stopped"));
  const next: TaskInfo = {
    ...before,
    taskId: id,
    toolUseId: id,
    type: "codex_subagent",
    description:
      str(metadata.agentNickname) || str(metadata.name) || before?.description || prompt || id,
    subagentType: str(metadata.agentRole) ?? before?.subagentType,
    status: nextStatus,
    prompt: before?.prompt ?? (prompt || str(metadata.preview) || undefined),
    startedAt:
      num(metadata.createdAt) === undefined
        ? (before?.startedAt ?? (nextStatus === "running" ? at : undefined))
        : Number(metadata.createdAt) * 1000,
    endedAt: nextStatus === "running" ? undefined : (before?.endedAt ?? at),
  };
  m.tasks = { ...m.tasks, [id]: next };
}

export function codexThreadItems(result: unknown): ChatItem[] {
  const thread = rec(rec(result)?.thread);
  if (!thread) return [];
  const draft = new Draft(emptyCodexModel());
  applyThread(draft, { thread }, 0, false);
  return draft.next.items;
}

function applyAgentTranscript(draft: CodexDraft, id: string, thread: Rec, seq: number): void {
  if (!Array.isArray(thread.turns)) return;
  const transcript = new Draft(emptyCodexModel());
  applyThread(transcript, { thread }, seq, false);
  const prefix = `codex-child:${id}:`;
  const items = transcript.next.items.map(
    (item): ChatItem =>
      item.kind === "assistant"
        ? {
            ...item,
            key: prefix + item.key,
            blocks: item.blocks.map((block) =>
              block.type === "tool" ? { ...block, toolUseId: prefix + block.toolUseId } : block,
            ),
          }
        : { ...item, key: prefix + item.key },
  );
  const m = draft.next;
  const prompt = items.find((item): item is UserItem => item.kind === "user");
  if (prompt?.text) applyNativeAgent(m, id, thread, undefined, prompt.text);
  m.nativeTranscripts = { ...m.nativeTranscripts, [id]: items };
  m.agentItems = {
    ...m.agentItems,
    [id]: items.filter((item): item is AssistantItem => item.kind === "assistant"),
  };
  for (const tool of Object.values(transcript.next.tools)) {
    const key = prefix + tool.id;
    draft.setTool(key, () => ({ ...tool, id: key, parentToolUseId: id }));
  }
}

function nextGoal(
  prev: CodexGoal | null | undefined,
  raw: unknown,
  at: number | undefined,
): CodexGoal | null {
  const goal = rec(raw);
  const objective = str(goal?.objective);
  const status = str(goal?.status);
  if (!goal || !objective || !CODEX_GOAL_STATUSES.includes(status as CodexGoalStatus)) return null;
  const complete = status === "complete";
  const createdAt = num(goal.createdAt);
  return {
    objective,
    status: status as CodexGoalStatus,
    timeUsedSeconds: num(goal.timeUsedSeconds) ?? 0,
    usedAt: at,
    tokensUsed: num(goal.tokensUsed) ?? 0,
    tokenBudget: num(goal.tokenBudget) ?? null,
    createdAt: createdAt !== undefined ? createdAt * 1000 : undefined,
    endedLive:
      complete &&
      prev !== undefined &&
      prev !== null &&
      prev.objective === objective &&
      (prev.status !== "complete" || prev.endedLive === true),
  };
}

function applyThread(draft: CodexDraft, result: Rec, seq: number, discoverAgents = true): void {
  const m = draft.next;
  const thread = rec(result.thread);
  const id = str(thread?.id);
  if (id && id !== m.threadId) {
    m.collaborationMode = undefined;
    m.collaborationSettings = undefined;
  }
  m.threadId = id ?? m.threadId;
  m.threadName = str(thread?.name) ?? m.threadName;
  m.version = str(thread?.cliVersion) ?? m.version;
  m.cwd = str(result.cwd) ?? m.cwd;
  applySettings(m, {
    model: result.model,
    serviceTier: result.serviceTier,
    effort: result.reasoningEffort,
    sandbox: result.sandbox,
  });
  m.sandboxMode = result.sandbox === undefined ? undefined : (modeOf(result.sandbox) ?? null);
  m.confirmedPermissionMode = confirmedModeOf(result.sandbox, result.approvalPolicy);
  if (result.collaborationMode) applyCollaboration(m, result.collaborationMode);
  else if (m.collaborationMode === undefined) {
    applyCollaboration(m, {
      mode: "default",
      settings: { reasoning_effort: result.reasoningEffort ?? null, developer_instructions: null },
    });
  }
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  turns.forEach((raw, t) => {
    const turn = rec(raw);
    const turnId = str(turn?.id);
    if (!turn || !turnId || !Array.isArray(turn.items)) return;
    if (turn.items.some((item) => rec(item)?.type === "enteredReviewMode")) m.reviewTurn = turnId;
    const startedAt = num(turn.startedAt);
    const first = m.items.length;
    inStartOrder(turn.items).forEach(({ item, i }) => {
      const at = num(item.startedAtMs) ?? (startedAt !== undefined ? startedAt * 1000 : undefined);
      applyItem(draft, turnId, item, "completed", `${seq}.${t}.${i}`, at, discoverAgents);
    });
    if (["completed", "interrupted", "failed"].includes(String(turn.status)))
      markHistoryBoundary(draft, turnId, turn.status === "completed", first);
  });
}

export function codexThreadModel(thread: { id: string; turns: unknown[] }): CodexModel {
  const draft: CodexDraft = new Draft(emptyCodexModel());
  applyThread(draft, { thread }, 0, false);
  return draft.next;
}

function markHistoryBoundary(
  draft: CodexDraft,
  turnId: string,
  completed: boolean,
  first = 0,
): void {
  if (!codexHistoryAvailable(codexServerVersion(draft.next, draft.installedVersion))) return;
  const items = draft.next.items;
  const prompt = items.findIndex(
    (item, i) => i >= first && item.kind === "user" && item.turnId === turnId,
  );
  const input = items[prompt];
  if (input?.kind === "user" && input.state === "taken" && !input.forkable) {
    draft.replaceItem(prompt, { ...input, forkable: true, rewindable: true });
  }
  if (!completed) return;
  const last = items.findLastIndex(
    (item, i) =>
      i >= first &&
      ((item.kind === "assistant" && item.messageId === turnId) ||
        (item.kind === "user" && item.turnId === turnId)),
  );
  const answer = items[last];
  if (answer?.kind === "assistant" && answer.blocks.at(-1)?.type === "text" && !answer.forkable) {
    draft.replaceItem(last, { ...answer, forkable: true });
  }
}

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
  settings: { model: unknown; effort: unknown; sandbox: unknown; serviceTier?: unknown },
) {
  m.model = str(settings.model) ?? m.model;
  if (settings.serviceTier === null || typeof settings.serviceTier === "string")
    m.serviceTier = settings.serviceTier;
  m.effort = str(settings.effort) ?? m.effort;
  m.permissionMode = modeOf(settings.sandbox) ?? m.permissionMode;
}

function applyCollaboration(m: CodexModel, value: unknown) {
  const collaboration = collaborationSettingsOf(value);
  if (!collaboration) return;
  const { mode, settings } = collaboration;
  m.collaborationMode = mode;
  m.collaborationSettings = { ...m.collaborationSettings, [mode]: settings };
  m.effort = settings.reasoning_effort ?? undefined;
}

function rememberCollaborationEffort(m: CodexModel, effort: unknown) {
  const mode = m.collaborationMode;
  const previous = mode && m.collaborationSettings?.[mode];
  if (mode && previous && typeof effort === "string") {
    m.collaborationSettings = {
      ...m.collaborationSettings,
      [mode]: { ...previous, reasoning_effort: effort },
    };
  }
}

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

function confirmedModeOf(sandbox: unknown, approvalPolicy: unknown): CodexMode | undefined {
  const mode = modeOf(sandbox);
  return mode === "fullAccess" && approvalPolicy !== "never" ? undefined : mode;
}

const OWN_THREAD_ONLY = new Set([
  "thread/tokenUsage/updated",
  "thread/settings/updated",
  "thread/compacted",
  "thread/goal/updated",
  "thread/goal/cleared",
]);

function applyNotification(
  draft: CodexDraft,
  method: string,
  params: Rec,
  seq: number,
  at: number | undefined,
): void {
  const m = draft.next;
  const keySeq = (m.logSeqOffset ?? 0) + seq;
  const tag = String(keySeq);
  const threadId = str(params.threadId);
  const another = threadId && m.threadId && threadId !== m.threadId;
  if (another) {
    applyNativeAgentNotification(m, threadId, method, params, at);
    if (!method.startsWith("thread/") || OWN_THREAD_ONLY.has(method)) return;
  }
  if (
    threadId &&
    !m.threadId &&
    Object.values(m.outgoing).some(({ subtype }) => subtype === "thread/fork")
  )
    return;
  switch (method) {
    case "turn/started": {
      const turnId = str(rec(params.turn)?.id);
      if (turnId) enterTurn(m, turnId);
      if (!m.running) {
        m.running = true;
        m.turn = { id: turnId, startedAt: at, outputTokens: 0, thinkingTokens: 0 };
      }
      noteTurnActivity(m, at);
      return;
    }
    case "turn/completed":
      applyTurnCompleted(draft, rec(params.turn) ?? {}, keySeq, at);
      return;
    case "item/started":
    case "item/completed": {
      const item = rec(params.item);
      const turnId = str(params.turnId) ?? m.turnId ?? "";
      if (item) {
        const completed = method === "item/completed";
        const phase = completed ? "completed" : "started";
        const toolRan =
          item.type === "commandExecution"
            ? applyCommandEvent(draft, turnId, item, phase, tag, at)
            : applyItem(draft, turnId, item, phase, tag, num(item.startedAtMs) ?? at);
        if (m.running && turnId === m.turnId) {
          noteTurnActivity(m, at);
          if (item.type !== "userMessage") clearRetry(m);
          if (completed && toolRan && m.permissions.length === 0) {
            m.toolCompletedSeq = seq;
          }
        }
      }
      return;
    }
    case "item/agentMessage/delta":
    case "item/plan/delta": {
      const delta = str(params.delta);
      const itemId = str(params.itemId);
      if (!delta || !itemId) return;
      appendText(draft, itemId, "text", delta, str(params.turnId) ?? m.turnId ?? "", tag, at);
      if (!params.turnId || params.turnId === m.turnId) {
        noteTurnActivity(m, at);
        clearRetry(m);
      }
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
      if (!params.turnId || params.turnId === m.turnId) {
        noteTurnActivity(m, at);
        clearRetry(m);
      }
      if (m.turn) {
        const thinkingTokens = m.turn.thinkingTokens + Math.ceil(delta.length / 4);
        m.turn = { ...m.turn, thinkingTokens };
      }
      return;
    }
    case "item/reasoning/summaryPartAdded": {
      const itemId = str(params.itemId);
      if (itemId && m.blocks[itemId]) appendText(draft, itemId, "thinking", "\n\n", "", tag, at);
      if (!params.turnId || params.turnId === m.turnId) noteTurnActivity(m, at);
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
    case "turn/plan/updated":
      if (Array.isArray(params.plan)) {
        m.plan = params.plan.flatMap<NonNullable<CodexModel["plan"]>[number]>((raw) => {
          const step = rec(raw);
          const content = str(step?.step);
          if (!content) return [];
          switch (step?.status) {
            case "pending":
            case "completed":
              return [{ content, status: step.status }];
            case "inProgress":
              return [{ content, status: "in_progress" }];
            default:
              return [];
          }
        });
      }
      return;
    case "mcpServer/startupStatus/updated": {
      const name = str(params.name);
      const status = str(params.status);
      if (name && status && m.mcpServers?.some((server) => server.name === name)) {
        m.mcpServers = m.mcpServers.map((server) =>
          server.name === name
            ? {
                ...server,
                status: status === "ready" ? "connected" : status,
                ...(status === "ready" ? { needsLogin: false } : {}),
              }
            : server,
        );
      }
      return;
    }
    case "mcpServer/oauthLogin/completed": {
      const name = str(params.name);
      const error = str(params.error);
      if (name && typeof params.success === "boolean") {
        m.mcpLogin = { seq, name, success: params.success, ...(error ? { error } : {}) };
      }
      return;
    }
    case "thread/started":
      return;
    case "thread/name/updated":
      if (!params.threadId || params.threadId === m.threadId) {
        m.threadName = str(params.threadName) ?? m.threadName;
      }
      return;
    case "thread/settings/updated": {
      const settings = rec(params.threadSettings);
      if (settings && (!params.threadId || params.threadId === m.threadId)) {
        applySettings(m, {
          model: settings.model,
          serviceTier: settings.serviceTier,
          effort: settings.effort,
          sandbox: settings.sandboxPolicy,
        });
        if (settings.sandboxPolicy !== undefined) {
          m.sandboxMode = modeOf(settings.sandboxPolicy) ?? null;
          m.confirmedPermissionMode = confirmedModeOf(
            settings.sandboxPolicy,
            settings.approvalPolicy,
          );
        } else if (
          settings.approvalPolicy !== undefined &&
          settings.approvalPolicy !== "never" &&
          m.confirmedPermissionMode === "fullAccess"
        ) {
          m.confirmedPermissionMode = undefined;
        }
        applyCollaboration(m, settings.collaborationMode);
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
      pushCompacted(draft, `n${keySeq}`, at);
      return;
    case "thread/goal/updated":
      m.threadGoal = nextGoal(m.threadGoal, params.goal, at);
      return;
    case "thread/goal/cleared":
      m.threadGoal = null;
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
          const told = codexRetryCount(str(error?.message));
          const status = codexErrorStatus(error?.codexErrorInfo);
          m.turn = {
            ...m.turn,
            retry: {
              attempt: told?.attempt ?? (m.turn.retry?.attempt ?? 0) + 1,
              ...(told ? { maxRetries: told.max } : {}),
              ...(at === undefined ? {} : { at }),
              ...(status === undefined ? {} : { status }),
              reason: retryReasonOf(status),
            },
          };
        }
        return;
      }
      pushError(draft, str(error?.message) ?? "error", `n${keySeq}`, at);
      return;
    }
    case "serverRequest/resolved": {
      const key = idKey(params.requestId);
      if (!key) return;
      if (m.requests[key]) {
        const { [key]: _resolved, ...rest } = m.requests;
        m.requests = rest;
        noteTurnActivity(m, at);
      }
      m.permissions = m.permissions.filter((p) => p.requestId !== key);
      return;
    }
  }
}

function applyTurnCompleted(draft: CodexDraft, turn: Rec, seq: number, at: number | undefined) {
  const m = draft.next;
  const status = str(turn.status) ?? "completed";
  if (status === "inProgress") return;
  const turnId = str(turn.id);
  if (turnId) {
    for (const raw of Array.isArray(turn.items) ? turn.items : []) {
      const item = rec(raw);
      const id = str(item?.id);
      if (
        item?.type === "commandExecution" &&
        id &&
        m.liveCommands?.[id]?.turnId === turnId &&
        (item.status === "completed" || item.status === "failed" || item.status === "declined")
      ) {
        applyCommandEvent(draft, turnId, item, "completed", String(seq), at);
      } else if (
        item?.type === "fileChange" &&
        (item.status === "completed" || item.status === "failed" || item.status === "declined")
      ) {
        applyItem(draft, turnId, item, "completed", `${seq}.${id}`, at);
      }
    }
    settleCommands(draft, at, turnId);
  }
  const sawTurnStart = turnId && turnId === m.turnId;
  m.running = false;
  m.turn = null;
  m.streaming = null;
  clearInterrupt(m);
  m.toolCompletedSeq = undefined;
  if (!turnId || turnId === m.turnId) m.turnId = undefined;
  const ended = Object.entries(m.requests).filter(([, r]) => r.params.turnId === turnId);
  if (turnId && ended.length > 0) {
    const keys = new Set(ended.map(([key]) => key));
    m.requests = Object.fromEntries(Object.entries(m.requests).filter(([key]) => !keys.has(key)));
    m.permissions = m.permissions.filter((p) => !keys.has(p.requestId));
  }
  if (sawTurnStart) markHistoryBoundary(draft, turnId, status === "completed");
  const apiFailure = status === "failed" ? codexTurnFailure(turn.error) : undefined;
  m.lastResult = {
    subtype: status,
    isError: status === "failed",
    ...(turnId ? { turnId } : {}),
    durationMs: num(turn.durationMs),
    at,
    ...(apiFailure ? { failure: apiFailure } : {}),
  };
  const failure = status === "failed" ? (str(rec(turn.error)?.message) ?? "failed") : undefined;
  finishSubmittedTurn(draft, turnId, failure);
  if (status === "interrupted" || status === "failed") {
    stopRunningTools(draft, (tool) => !tool.parentToolUseId && !m.liveCommands?.[tool.id]);
  }
  if (status === "interrupted") {
    draft.push({ kind: "notice", key: `n${seq}`, code: "interrupted", at });
  } else if (status === "failed") {
    pushError(draft, failure ?? "failed", `n${seq}`, at);
  }
}

function setCommandJob(
  m: CodexModel,
  id: string,
  status: string,
  startedAt: number | undefined,
  endedAt?: number,
  durationMs?: number,
): void {
  const tool = m.tools[id];
  if (!tool) return;
  const taskId = `codex-command:${id}`;
  const elapsed =
    startedAt !== undefined && endedAt !== undefined ? endedAt - startedAt : durationMs;
  if (
    !m.tasks[taskId] &&
    status !== "running" &&
    elapsed !== undefined &&
    elapsed < WAITED_CALL_DELAY_MS
  )
    return;
  m.tasks = {
    ...m.tasks,
    [taskId]: {
      taskId,
      type: "local_bash",
      toolUseId: id,
      description: commandLabel(tool),
      status,
      startedAt,
      endedAt,
    },
  };
}

function forgetCommand(m: CodexModel, id: string): void {
  const { [id]: _command, ...rest } = m.liveCommands ?? {};
  m.liveCommands = Object.keys(rest).length > 0 ? rest : undefined;
}

function applyCommandEvent(
  draft: CodexDraft,
  turnId: string,
  item: Rec,
  phase: "started" | "completed",
  tag: string,
  at: number | undefined,
): boolean | undefined {
  const m = draft.next;
  const id = str(item.id);
  if (!id) return;
  const live = m.liveCommands?.[id];
  const job = m.tasks[`codex-command:${id}`];
  if (live && phase === "completed" && live.turnId !== turnId) return;
  const when = num(item.startedAtMs) ?? at;
  const canContinue =
    live?.canContinue === true ||
    str(item.processId) !== undefined ||
    item.source === "unifiedExecStartup" ||
    item.source === "unifiedExecInteraction";
  const stillRunning =
    canContinue && item.status === "inProgress" && num(item.exitCode) === undefined;
  const toolRan = applyItem(draft, turnId, item, stillRunning ? "started" : phase, tag, when);
  const tool = m.tools[id];
  if (!tool) return toolRan;
  if (tool.status === "running") {
    const command = { turnId, startedAt: live?.startedAt ?? when, canContinue };
    m.liveCommands = { ...m.liveCommands, [id]: command };
    if (job?.status === "running") markCommandBackground(draft, tool);
    return false;
  }
  if (live || job) {
    const status =
      tool.status === "done" ? "completed" : tool.status === "error" ? "failed" : "stopped";
    setCommandJob(
      m,
      id,
      status,
      live?.startedAt ?? job?.startedAt,
      num(item.completedAtMs) ?? at,
      num(item.durationMs),
    );
    if (live) forgetCommand(m, id);
  }
  return toolRan;
}

function markCommandBackground(draft: CodexDraft, tool: ToolCall): void {
  draft.setTool(tool.id, () => ({
    ...tool,
    input: { ...rec(tool.input), run_in_background: true },
  }));
}

function settleCommands(draft: CodexDraft, at: number | undefined, turnId?: string): void {
  const m = draft.next;
  for (const [id, command] of Object.entries(m.liveCommands ?? {})) {
    if (turnId !== undefined && command.turnId !== turnId) continue;
    const tool = m.tools[id];
    if (turnId !== undefined && command.canContinue && tool?.status === "running") {
      markCommandBackground(draft, tool);
      setCommandJob(m, id, "running", command.startedAt);
      continue;
    }
    if (tool?.status === "running") draft.setTool(id, () => ({ ...tool, status: "stopped" }));
    setCommandJob(m, id, "stopped", command.startedAt, at);
    forgetCommand(m, id);
  }
}

function clearRetry(m: CodexModel): void {
  if (m.turn?.retry) m.turn = { ...m.turn, retry: undefined };
}

function pushError(draft: CodexDraft, detail: string, key: string, at: number | undefined) {
  const last = draft.next.items.at(-1);
  if (last?.kind === "notice" && last.code === "error" && last.detail === detail) return;
  draft.push({ kind: "notice", key, code: "error", detail, at });
}

function pushCompacted(draft: CodexDraft, key: string, at: number | undefined) {
  const last = draft.next.items.at(-1);
  if (last?.kind === "notice" && last.code === "compacted") return;
  draft.push({ kind: "notice", key, code: "compacted", at });
}

function applyItem(
  draft: CodexDraft,
  turnId: string,
  item: Rec,
  phase: "started" | "completed",
  tag: string,
  at: number | undefined,
  discoverAgents = true,
): boolean | undefined {
  const m = draft.next;
  const id = str(item.id);
  if (!id) return;
  switch (item.type) {
    case "userMessage": {
      if (m.items.some((i) => i.kind === "user" && i.uuid === id)) return;
      const clientId = str(item.clientId);
      if (clientId && takeUser(draft, `u-${clientId}`, id, turnId)) return;
      if (m.reviewTurn === turnId) return;
      const index = m.items.findIndex(
        (i) => i.kind === "user" && i.key.startsWith("u-") && i.uuid === undefined,
      );
      if (!clientId && index >= 0) {
        const sent = m.items[index] as UserItem;
        draft.replaceItem(index, {
          ...sent,
          state: "taken",
          uuid: id,
          ...(turnId ? { turnId } : {}),
        });
        return;
      }
      const { text, images } = userInputOf(item.content);
      draft.push({
        kind: "user",
        key: clientId?.startsWith("peer-") ? `u-${clientId}` : `u${tag}`,
        uuid: id,
        text,
        images,
        state: "taken",
        ...(turnId ? { turnId } : {}),
        at,
      });
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
      if (m.turn && m.turnId === turnId) {
        if (phase === "started") m.turn = { ...m.turn, status: "compacting" };
        else if (m.turn.status === "compacting") m.turn = { ...m.turn, status: undefined };
      }
      if (phase === "completed") pushCompacted(draft, `n${tag}`, at);
      return;
    case "enteredReviewMode":
      m.reviewTurn = turnId;
      if (!m.items.some((i) => i.key === `r${id}`)) {
        draft.push({ kind: "notice", key: `r${id}`, code: "review", detail: str(item.review), at });
      }
      return;
  }
  if (discoverAgents) applyNativeAgentItem(m, item, at);
  const tools = codexItemTools(item, id, phase);
  if (!tools) return;
  const ran =
    item.status !== "declined" && !tools.some((tool) => m.tools[tool.id]?.status === "denied");
  for (const tool of tools) {
    const known = m.tools[tool.id];
    draft.setTool(tool.id, (prev) => mergeTool(prev, tool));
    if (!known) addBlock(draft, turnId, { type: "tool", toolUseId: tool.id }, tag, at);
  }
  return ran;
}

function applyNativeAgentItem(m: CodexModel, item: Rec, at: number | undefined): void {
  if (item.type === "subAgentActivity") {
    const id = str(item.agentThreadId);
    const status =
      item.kind === "completed" ? "completed" : item.kind === "interrupted" ? "stopped" : "running";
    if (id && id !== m.threadId) applyNativeAgent(m, id, {}, status, undefined, at);
  }
  if (item.type !== "collabAgentToolCall" || !Array.isArray(item.receiverThreadIds)) return;
  if (item.senderThreadId && item.senderThreadId !== m.threadId) return;
  for (const id of item.receiverThreadIds) {
    if (typeof id !== "string" || id === m.threadId) continue;
    const state = str(rec(rec(item.agentsStates)?.[id])?.status);
    const status =
      state === "completed"
        ? "completed"
        : state === "errored"
          ? "failed"
          : state === "interrupted" || state === "shutdown"
            ? "stopped"
            : state === "pendingInit" || state === "running" || item.tool === "spawnAgent"
              ? "running"
              : undefined;
    applyNativeAgent(
      m,
      id,
      {},
      status,
      item.tool === "spawnAgent" ? str(item.prompt) : undefined,
      at,
    );
  }
}

function mergeTool(prev: ToolCall | undefined, next: ToolCall): ToolCall {
  if (!prev) return next;
  return {
    ...next,
    status: prev.status === "denied" && next.status !== "done" ? "denied" : next.status,
    result: next.result ?? prev.result,
  };
}

function enterTurn(m: CodexModel, turnId: string): void {
  if (turnId !== m.turnId) {
    clearInterrupt(m);
    m.blocks = {};
    m.toolCompletedSeq = undefined;
  }
  m.turnId = turnId;
  if (m.turn && m.turn.id !== turnId) m.turn = { ...m.turn, id: turnId };
}

function takeUser(
  draft: CodexDraft,
  key: string,
  uuid: string | undefined,
  turnId: string | undefined,
): boolean {
  const items = draft.next.items;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind !== "user" || item.key !== key) continue;
    draft.replaceItem(i, {
      ...item,
      state: "taken",
      ...(uuid ? { uuid } : {}),
      ...(turnId ? { turnId } : {}),
    });
    return true;
  }
  return false;
}

function assistantIndex(draft: CodexDraft, turnId: string, tag: string, at: number | undefined) {
  const items = draft.next.items;
  const last = items.at(-1);
  if (last?.kind === "assistant" && last.messageId === turnId) return items.length - 1;
  draft.push({
    kind: "assistant",
    key: `a${tag}`,
    messageId: turnId,
    ...(turnId ? { turnId } : {}),
    blocks: [],
    at,
  });
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

export function codexItemTools(
  item: Rec,
  id: string,
  phase: "started" | "completed",
): ToolCall[] | null {
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

const SHELL_SCRIPT = /^(?:\S*\/)?(?:bash|zsh|sh) -l?c (.+)$/s;

const POWERSHELL_SCRIPT =
  /^(?:"[^"]*[\\/]|[^\s"]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"? -Command (.+)$/is;

export function shownCommand(command: string): string {
  const script = (SHELL_SCRIPT.exec(command) ?? POWERSHELL_SCRIPT.exec(command))?.[1];
  return (script === undefined ? null : shellWord(script)) ?? command;
}

export function shellName(command: string): "PowerShell" | "Bash" | "Shell" {
  if (POWERSHELL_SCRIPT.test(command)) return "PowerShell";
  if (SHELL_SCRIPT.test(command)) return "Bash";
  return "Shell";
}

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
    if (!line.startsWith("\\")) hunks.at(-1)?.lines.push(line);
  }
  return hunks;
}

function withoutMoveTail(diff: string): string {
  return diff.replace(/\n\nMoved to: [^\n]*$/, "");
}

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

function pathKey(path: string): string {
  return /^[A-Za-z]:[\\/]/.test(path) ? path.replace(/\\/g, "/").toLowerCase() : path;
}

function changedPathOf(tool: ToolCall): string {
  const input = rec(tool.input);
  const path = str(input?.file_path) ?? "";
  const from = str(input?.moved_from);
  return from ? `${from} → ${path}` : path;
}

function toolIdsOf(m: CodexModel, itemId: string): string[] {
  return Object.keys(m.tools).filter((id) => id === itemId || id.startsWith(`${itemId}:`));
}

const SESSION_SUGGESTION = { type: "session" };

function applyServerRequest(draft: CodexDraft, key: string, method: string, params: Rec): void {
  const m = draft.next;
  m.requests = { ...m.requests, [key]: { method, params } };
  const permission = permissionOf(m, key, method, params);
  if (permission) {
    m.toolCompletedSeq = undefined;
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
                id: str(q.id),
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

export function shownUserText(text: string): string {
  return text.trim() === CODEX_INIT_PROMPT.trim() ? "/init" : text;
}

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
  const text = shownUserText(texts.join("\n"));
  if (mentions.length === 0) return { text, images };
  return { text: text ? `${text}\n\n${mentions.join(" ")}` : mentions.join(" "), images };
}

function dataImage(url: string | undefined): ImageBlock | null {
  const match = url ? /^data:([^;,]+);base64,(.*)$/s.exec(url) : null;
  return match ? { mediaType: match[1], data: match[2] } : null;
}

export function codexModelsOf(data: unknown): ModelInfo[] {
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
    const tiers = Array.isArray(model.serviceTiers) ? model.serviceTiers.map(rec) : [];
    const tierIds = tiers.flatMap((tier) => str(tier?.id) ?? []);
    if (!Array.isArray(model.serviceTiers) && Array.isArray(model.additionalSpeedTiers)) {
      for (const tier of model.additionalSpeedTiers) {
        if (tier === "fast" || tier === "priority") tierIds.push("priority");
      }
    }
    const fast = tiers.find(
      (tier) =>
        tier &&
        (str(tier.name)?.toLowerCase() === "fast" || tier.id === "priority" || tier.id === "fast"),
    );
    const tierId = str(fast?.id);
    return [
      {
        value,
        ...(model.isDefault === true ? { isDefault: true } : {}),
        ...(tierIds.length ? { serviceTiers: tierIds } : {}),
        ...(tierId
          ? {
              fastTier: {
                id: tierId,
                description: str(fast?.description),
                isDefault: model.defaultServiceTier === tierId,
              },
            }
          : {}),
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

export function rateLimitsOf(raw: unknown): CodexRateLimits | undefined {
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

export function mergeRateLimits(
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

function accountOf(raw: unknown): { type: string } | null {
  const account = rec(raw);
  return account ? { type: str(account.type) ?? "unknown" } : null;
}
