// The conversation a Claude tab shows, rebuilt from the lines of its
// program's log: what `claude -p --output-format stream-json` wrote (out),
// what the app wrote it (in), and the agent's own start and exit (sys).
//
// applyLine is a pure reducer, so the same lines give the same view live
// and when a reloaded window replays the log. Fields Claude Code adds in
// later versions are ignored, and every field it may leave out is read as
// maybe absent: the protocol grows across 2.1.x releases (#159).

import { terminalText } from "../editor/preview/notebook";
import { type ClaudeGoal, goalFeedbackReason } from "./goal";
import { appliedEffort, settingsChoice, settingsModel } from "./settings-defaults";

export type LineDir = "out" | "in" | "sys";

export interface ChatLine {
  seq: number;
  dir: LineDir;
  message?: unknown;
  text?: string;
  /** When the agent got the line, in Unix milliseconds. */
  at?: number;
  replay?: boolean;
}

export interface ImageBlock {
  mediaType: string;
  data: string;
}

export interface UserItem {
  kind: "user";
  key: string;
  /** The CLI's uuid for the message, once it has taken it. */
  uuid?: string;
  text: string;
  images: ImageBlock[];
  /** sent: written to the CLI; taken: the CLI echoed it back. */
  state: "sent" | "taken";
  /** The uuid the app wrote it with, which the CLI's echo and lifecycle name. */
  sentUuid?: string;
  /**
   * Written during a turn: the CLI reads it after the tool it runs, and till
   * then it waits above the box, where it can still be taken back.
   */
  queued?: boolean;
  /** Codex: the turn it went into, which a resumed thread keeps (not `uuid`). */
  turnId?: string;
  at?: number;
}

/** A message written during a turn that the CLI has not read yet. */
export function isWaiting(item: ChatItem): item is UserItem {
  return item.kind === "user" && item.state === "sent" && item.queued === true;
}

export type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; toolUseId: string };

export interface AssistantItem {
  kind: "assistant";
  key: string;
  messageId: string;
  uuid?: string;
  blocks: AssistantBlock[];
  at?: number;
}

export type NoticeCode =
  | "interrupted"
  | "exited"
  | "restarted"
  | "compacted"
  | "cleared"
  | "error"
  | "dropped"
  /** A thread the app could not go on with; it started a new one. */
  | "not_resumed"
  /** Codex began reviewing (/review): what it looks at is the detail. */
  | "review"
  /** A goal set, cleared, met or found impossible (/goal): its condition is the detail. */
  | "goal_set"
  | "goal_cleared"
  | "goal_met"
  | "goal_failed";

export interface NoticeItem {
  kind: "notice";
  key: string;
  code: NoticeCode;
  detail?: string;
  at?: number;
}

/** Who wrote a message the CLI took, when it was not the user. */
export interface MessageSource {
  /**
   * peer (another session, a teammate), channel, coordinator, or as the CLI
   * names it; tab, terminal or manager for an agent that sent it through
   * the nexus command.
   */
  kind: string;
  /** The session's or teammate's name, the channel's server; the tab's title. */
  name?: string;
  /** The agent that sent it through the nexus command: claude or codex. */
  agent?: string;
  /** The tab it was sent from through the nexus command: on `device`, when it names one. */
  workspaceId?: string;
  tabId?: string;
  /** The user's other computer it was sent from, as it names itself; none for this one. */
  device?: { id: string; name: string };
  /** How many messages between agents led to it, the first being 1. */
  hops?: number;
}

/**
 * A message the CLI took that the user did not write: another session's, a
 * channel's, the coordinator's. Claude answers it as it does the user's.
 */
export interface ReceivedItem {
  kind: "received";
  key: string;
  uuid?: string;
  from: MessageSource;
  text: string;
  at?: number;
}

/** A task that ended while Claude did not wait for it: the news of it wakes Claude. */
export interface TaskEndItem {
  kind: "task_end";
  key: string;
  taskId: string;
  /** completed, failed, killed or stopped. */
  status: string;
  /** What the task was, when the news or the tab's tasks tell. */
  description?: string;
  /** local_bash, local_agent…, when the tab's tasks tell. */
  taskType?: string;
  summary?: string;
  toolUseId?: string;
  /** It came with no turn running, and Claude's next words answer it: another turn. */
  wakes?: boolean;
  at?: number;
}

/** A shell command the user ran in the terminal's Claude Code (`!command`), with its output. */
export interface ShellItem {
  kind: "shell";
  key: string;
  command: string;
  stdout?: string;
  stderr?: string;
  at?: number;
}

export type ChatItem =
  | UserItem
  | AssistantItem
  | NoticeItem
  | ReceivedItem
  | TaskEndItem
  | ShellItem;

/** Whether what comes after an item is another turn: a message Claude answers, or news that wakes it. */
export function opensTurn(item: ChatItem): boolean {
  return (
    item.kind === "user" ||
    item.kind === "received" ||
    (item.kind === "task_end" && item.wakes === true)
  );
}

/** The origins of a message that is someone's, though not the user's: shown even when the CLI marks it its own. */
export const SENDER_KINDS: ReadonlySet<string> = new Set(["peer", "channel", "coordinator"]);

export interface ToolResult {
  text: string;
  isError: boolean;
  /** The CLI's `tool_use_result`: a Bash run's stdout, an edit's patch. */
  structured?: unknown;
  images: ImageBlock[];
}

export interface ToolCall {
  id: string;
  name: string;
  /** The name a row shows when it is not `name`: the shell a Codex command runs in. */
  displayName?: string;
  input: unknown;
  /** The input JSON as streamed so far, before the call arrives whole. */
  partialInput?: string;
  status: "streaming" | "running" | "done" | "error" | "denied" | "stopped";
  result?: ToolResult;
  /** The Agent tool call this one runs under; null on the main thread. */
  parentToolUseId: string | null;
}

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  displayName?: string;
  input: Record<string, unknown>;
  description?: string;
  suggestions: unknown[];
  decisionReason?: string;
  toolUseId?: string;
  /** A subagent's request carries its id. */
  agentId?: string;
  /** The call as the card previews it, when the input alone does not tell it (a Codex patch). */
  preview?: ToolCall;
}

export interface StreamingBlock {
  type: "text" | "thinking" | "tool_use";
  text: string;
  toolUseId?: string;
}

export interface StreamingMessage {
  messageId: string;
  blocks: Record<number, StreamingBlock>;
}

export interface TurnState {
  startedAt?: number;
  outputTokens: number;
  thinkingTokens: number;
  /** requesting: waiting on the API; compacting: /compact runs. */
  status?: string;
  retry?: { attempt: number; maxRetries?: number; delayMs?: number };
}

export interface ModelInfo {
  value: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportedEffortLevels?: string[];
}

/**
 * The model info the session runs, as the CLI names it either way (alias or
 * id). A model `chosen` ("opus") goes by its own name even where the default
 * runs the same one ("default" and "opus" both claude-opus-5-5): the default
 * is what runs when nothing chose a model.
 */
export function currentModelInfo(
  models: readonly ModelInfo[],
  current: string | undefined,
  chosen?: string,
): ModelInfo | undefined {
  // Before its first turn the session names no model: it runs the default.
  if (!current) return models.find((m) => m.value === "default");
  const named =
    chosen && longContextBase(chosen) !== "default"
      ? models.filter((m) => m.value !== "default")
      : models;
  return modelInfoOf(named, current) ?? modelInfoOf(models, current);
}

/** "claude-opus-5-5[1m]" is Opus 5.5 with its long context. */
function longContextBase(model: string): string {
  return model.replace(/\[[^\]]*\]$/, "");
}

function modelInfoOf(models: readonly ModelInfo[], current: string): ModelInfo | undefined {
  const base = longContextBase(current);
  return (
    models.find((m) => m.value === current) ??
    models.find((m) => m.resolvedModel === current) ??
    models.find((m) => m.value === base || m.resolvedModel === base) ??
    // A dated id is its model's; the longest name it starts with, so
    // "claude-opus-5-5…" is not taken for "claude-opus-5".
    models
      .filter((m) => current.startsWith(m.value))
      .sort((a, b) => b.value.length - a.value.length)[0]
  );
}

export interface CommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
  aliases?: string[];
}

export interface InitializeInfo {
  commands: CommandInfo[];
  models: ModelInfo[];
  /** The account may turn on Remote Control. */
  remoteControl: boolean;
  /** The output styles /config takes, the user's own among them. */
  outputStyles?: string[];
  /** Who the program is signed in as, for /status. */
  account?: AccountInfo;
}

export interface AccountInfo {
  email?: string;
  organization?: string;
  subscription?: string;
  /** firstParty, bedrock, vertex… */
  provider?: string;
}

export interface ResultInfo {
  subtype: string;
  isError: boolean;
  durationMs?: number;
  numTurns?: number;
  costUsd?: number;
  terminalReason?: string;
  /** When the turn ended, in Unix milliseconds; told for Codex's turns. */
  at?: number;
}

/** A task the CLI runs beside the turn: a background Bash, a subagent, a teammate. */
export interface TaskInfo {
  taskId: string;
  /** local_bash, local_agent, in_process_teammate, a workflow's, as the CLI names it. */
  type: string;
  description: string;
  /** running, then completed, failed, killed or stopped. */
  status: string;
  /** The tool call that started it: an Agent call, a Bash run in the background. */
  toolUseId?: string;
  subagentType?: string;
  prompt?: string;
  backgrounded?: boolean;
  startedAt?: number;
  endedAt?: number;
  summary?: string;
  outputFile?: string;
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
  lastToolName?: string;
  /** What it does now, as its last progress said ("Running Sleep 8 seconds"). */
  activity?: string;
}

export interface McpServerInfo {
  name: string;
  status: string;
  scope?: string;
  transport?: string;
}

export interface RateLimitInfo {
  status: string;
  resetsAt?: number;
  rateLimitType?: string;
}

export interface ChatModel {
  lastSeq: number;
  items: ChatItem[];
  tools: Record<string, ToolCall>;
  permissions: PermissionRequest[];
  streaming: StreamingMessage | null;
  sessionId?: string;
  /** The model the session runs, as the CLI names it ("claude-haiku-5-5"). */
  model?: string;
  /**
   * The model the tab or the settings chose, as they name it ("opus"); none
   * when nothing chose one and the default runs.
   */
  chosenModel?: string;
  permissionMode?: string;
  effort?: string;
  cwd?: string;
  version?: string;
  init?: InitializeInfo;
  running: boolean;
  turn: TurnState | null;
  process: "none" | "running" | "exited";
  exit?: { code: number | null; signal?: string; stderrTail?: string };
  lastResult?: ResultInfo;
  /**
   * What the tab's processes have cost, at list price: each result tells
   * its process's total so far, which starts again with a new process.
   */
  costUsd?: number;
  /** The running process's part of costUsd. */
  processCostUsd?: number;
  /** How many times /clear started the conversation over, under a new session id. */
  clears?: number;
  /**
   * Why bypassPermissions can't be switched to, as the CLI answered a try:
   * a setting or policy disables it (Claude Code says so only then).
   */
  bypassBlocked?: string;
  rateLimit?: RateLimitInfo;
  contextUsage?: unknown;
  /** get_usage's answer: the plan's limits, as the server sends them. */
  usage?: unknown;
  mcp?: McpServerInfo[];
  remoteControl?: { enabled: boolean; sessionUrl?: string };
  /** The CLI's tasks by id, in the order they started. */
  tasks: Record<string, TaskInfo>;
  /** Subagents' messages, by the Agent tool call they run under. */
  agentItems: Record<string, AssistantItem[]>;
  /** The app asked the turn to stop: its tools' errors are the stop. */
  interrupting?: boolean;
  /** The app's control requests waiting for an answer: request id → subtype and request. */
  outgoing: Record<string, { subtype: string; request: Record<string, unknown> }>;
  /**
   * The log began with a program going on with an earlier session: what
   * came before is in the session's transcript, not here.
   */
  resumed?: boolean;
  /** The goal Claude works toward (/goal); null once it was cleared. */
  goal?: ClaudeGoal | null;
}

export function emptyModel(): ChatModel {
  return {
    lastSeq: 0,
    items: [],
    tools: {},
    permissions: [],
    streaming: null,
    running: false,
    turn: null,
    process: "none",
    outgoing: {},
    tasks: {},
    agentItems: {},
  };
}

type Rec = Record<string, unknown>;

export function rec(value: unknown): Rec | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : null;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function time(value: unknown): number | undefined {
  const text = str(value);
  if (text === undefined) return undefined;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : ms;
}

/** A draft of the model that copies what it changes, once. */
export class Draft<M extends ChatModel = ChatModel> {
  readonly next: M;
  private itemsCopied = false;
  private toolsCopied = false;

  constructor(prev: M) {
    this.next = { ...prev };
  }

  items(): ChatItem[] {
    if (!this.itemsCopied) {
      this.next.items = [...this.next.items];
      this.itemsCopied = true;
    }
    return this.next.items;
  }

  setTool(id: string, update: (prev: ToolCall | undefined) => ToolCall): void {
    if (!this.toolsCopied) {
      this.next.tools = { ...this.next.tools };
      this.toolsCopied = true;
    }
    this.next.tools[id] = update(this.next.tools[id]);
  }

  push(item: ChatItem): void {
    this.items().push(item);
  }

  replaceItem(index: number, item: ChatItem): void {
    this.items()[index] = item;
  }

  removeItem(index: number): void {
    this.items().splice(index, 1);
  }
}

/** Applies one line to the model. Lines at or before lastSeq are skipped. */
export function applyLine(prev: ChatModel, line: ChatLine, now: number = Date.now()): ChatModel {
  if (line.seq <= prev.lastSeq) return prev;
  const draft = new Draft(prev);
  applyLineTo(draft, line, now);
  return draft.next;
}

function applyLineTo(draft: Draft, line: ChatLine, now: number): void {
  draft.next.lastSeq = line.seq;
  const message = rec(line.message);
  if (!message) return;
  // The agent stamps each line; without its stamp, a live line happens now.
  const at = line.at ?? (line.replay ? undefined : now);
  if (line.dir === "sys") applySys(draft, message, line.seq, at);
  else if (line.dir === "in") applyIn(draft, message, line.seq, at);
  else applyOut(draft, message, line.seq, at, !line.replay);
}

/**
 * Applies lines to the model in one draft, so what they change is copied
 * once for them all. A draft for each line copied the tab's calls and
 * messages, as many as the session has, for each line: a long session's
 * transcript, or a frame's lines, took that many copies.
 */
export function applyLines(prev: ChatModel, lines: readonly ChatLine[], now?: number): ChatModel {
  let draft: Draft | undefined;
  for (const line of lines) {
    if (line.seq <= (draft?.next ?? prev).lastSeq) continue;
    draft ??= new Draft(prev);
    applyLineTo(draft, line, now ?? Date.now());
  }
  return draft?.next ?? prev;
}

/** The agent's own lines: the program started, exited, or the log dropped lines. */
export function applySys(draft: Draft, message: Rec, seq: number, at: number | undefined): void {
  const m = draft.next;
  switch (message.event) {
    case "start":
      if (m.process === "none" && m.items.length === 0) m.resumed = message.resumed === true;
      if (m.process === "exited")
        draft.push({ kind: "notice", key: `n${seq}`, code: "restarted", at });
      m.process = "running";
      m.processCostUsd = 0;
      m.exit = undefined;
      m.outgoing = {};
      m.permissions = [];
      m.running = false;
      m.turn = null;
      m.streaming = null;
      return;
    case "exit": {
      const code = num(message.code) ?? null;
      const signal = str(message.signal);
      // What the program wrote to a terminal: Codex colours its log lines.
      const stderr = str(message.stderrTail);
      const stderrTail = stderr === undefined ? undefined : terminalText(stderr);
      m.process = "exited";
      m.exit = { code, ...(signal ? { signal } : {}), ...(stderrTail ? { stderrTail } : {}) };
      m.running = false;
      m.turn = null;
      m.streaming = null;
      m.permissions = [];
      m.outgoing = {};
      stopRunningTools(draft);
      stopRunningTasks(draft, at);
      draft.push({ kind: "notice", key: `n${seq}`, code: "exited", detail: stderrTail, at });
      return;
    }
    case "dropped":
      draft.push({ kind: "notice", key: `n${seq}`, code: "dropped", at });
      return;
  }
}

function applyIn(draft: Draft, message: Rec, seq: number, at: number | undefined): void {
  const m = draft.next;
  switch (message.type) {
    case "user": {
      const { text, images } = userContent(rec(message.message)?.content);
      const sentUuid = str(message.uuid);
      // A message to read at once is not left waiting.
      const queued = m.running && message.priority !== "now";
      draft.push({
        kind: "user",
        key: `u${seq}`,
        text,
        images,
        state: "sent",
        ...(sentUuid ? { sentUuid } : {}),
        ...(queued ? { queued } : {}),
        at,
      });
      if (!m.running) {
        m.running = true;
        m.turn = { startedAt: at, outputTokens: 0, thinkingTokens: 0 };
      }
      return;
    }
    case "control_request": {
      const id = str(message.request_id);
      const request = rec(message.request);
      const subtype = str(request?.subtype);
      if (id && request && subtype) m.outgoing = { ...m.outgoing, [id]: { subtype, request } };
      if (subtype === "interrupt" && m.running) m.interrupting = true;
      return;
    }
    case "control_response": {
      // The app answered a request of the CLI's: a permission.
      const response = rec(message.response);
      const id = str(response?.request_id);
      if (!id) return;
      const answered = m.permissions.find((p) => p.requestId === id);
      if (!answered) return;
      m.permissions = m.permissions.filter((p) => p.requestId !== id);
      const behavior = str(rec(response?.response)?.behavior);
      if (behavior === "deny" && answered.toolUseId) {
        const toolUseId = answered.toolUseId;
        if (m.tools[toolUseId])
          draft.setTool(toolUseId, (t) => ({ ...(t as ToolCall), status: "denied" }));
      }
      return;
    }
  }
}

function applyOut(
  draft: Draft,
  message: Rec,
  seq: number,
  at: number | undefined,
  live = true,
): void {
  switch (message.type) {
    case "system":
      applySystem(draft, message, seq, at);
      return;
    case "stream_event":
      applyStreamEvent(draft, message);
      return;
    case "assistant":
      applyAssistant(draft, message, seq, at);
      return;
    case "user":
      applyUserOut(draft, message, seq, at, live);
      return;
    case "result":
      applyResult(draft, message, seq, at);
      return;
    case "goal_status":
      applyGoalStatus(draft, message, seq, at);
      return;
    case "control_request":
      applyControlRequest(draft, message);
      return;
    case "control_cancel_request": {
      const id = str(message.request_id);
      if (id) draft.next.permissions = draft.next.permissions.filter((p) => p.requestId !== id);
      return;
    }
    case "control_response":
      applyControlResponse(draft, message, seq, at);
      return;
    case "command_lifecycle": {
      // A waiting message taken back before the CLI read it.
      if (message.state !== "cancelled") return;
      const uuid = str(message.command_uuid);
      const index = draft.next.items.findIndex((item) => isWaiting(item) && item.sentUuid === uuid);
      if (uuid && index >= 0) draft.removeItem(index);
      return;
    }
    case "conversation_reset": {
      // /clear: the session goes on under a new id, which the next init
      // tells, with nothing of what came before.
      const m = draft.next;
      m.items = [{ kind: "notice", key: `n${seq}`, code: "cleared", at }];
      m.tools = {};
      m.agentItems = {};
      m.contextUsage = undefined;
      m.clears = (m.clears ?? 0) + 1;
      m.goal = undefined;
      return;
    }
    case "rate_limit_event": {
      const info = rec(message.rate_limit_info);
      const status = str(info?.status);
      if (info && status) {
        draft.next.rateLimit = {
          status,
          resetsAt: num(info.resetsAt),
          rateLimitType: str(info.rateLimitType),
        };
      }
      return;
    }
  }
}

function applySystem(draft: Draft, message: Rec, seq: number, at: number | undefined): void {
  const m = draft.next;
  switch (message.subtype) {
    case "init": {
      m.sessionId = str(message.session_id) ?? m.sessionId;
      m.model = str(message.model) ?? m.model;
      m.permissionMode = str(message.permissionMode) ?? m.permissionMode;
      m.cwd = str(message.cwd) ?? m.cwd;
      m.version = str(message.claude_code_version) ?? m.version;
      return;
    }
    case "status": {
      const mode = str(message.permissionMode);
      if (mode) m.permissionMode = mode;
      if (m.turn) m.turn = { ...m.turn, status: str(message.status) };
      return;
    }
    case "thinking_tokens": {
      const tokens = num(message.estimated_tokens);
      if (m.turn && tokens !== undefined) m.turn = { ...m.turn, thinkingTokens: tokens };
      return;
    }
    case "api_retry": {
      if (m.turn) {
        m.turn = {
          ...m.turn,
          retry: {
            attempt: num(message.attempt) ?? 1,
            maxRetries: num(message.max_retries),
            delayMs: num(message.retry_delay_ms),
          },
        };
      }
      return;
    }
    case "compact_boundary":
      draft.push({ kind: "notice", key: `n${seq}`, code: "compacted", at });
      return;
    case "task_started":
    case "task_progress":
    case "task_updated":
      applyTask(draft, message, at);
      return;
    case "task_notification":
      applyTask(draft, message, at);
      applyTaskEnd(draft, message, at);
      return;
    case "background_tasks_changed": {
      if (!Array.isArray(message.tasks)) return;
      for (const raw of message.tasks) {
        const task = rec(raw);
        const id = str(task?.task_id);
        if (!task || !id || m.tasks[id]) continue;
        m.tasks = {
          ...m.tasks,
          [id]: {
            taskId: id,
            type: str(task.task_type) ?? "",
            description: str(task.description) ?? "",
            status: "running",
            subagentType: str(task.subagent_type),
            backgrounded: true,
            startedAt: at,
          },
        };
      }
      return;
    }
  }
}

function applyTask(draft: Draft, message: Rec, at: number | undefined): void {
  const m = draft.next;
  const id = str(message.task_id);
  if (!id) return;
  const prev: TaskInfo = m.tasks[id] ?? {
    taskId: id,
    type: str(message.task_type) ?? "",
    description: "",
    status: "running",
    startedAt: at,
  };
  const next: TaskInfo = { ...prev };
  const set = <K extends keyof TaskInfo>(key: K, value: TaskInfo[K] | undefined) => {
    if (value !== undefined) next[key] = value;
  };
  set("type", str(message.task_type));
  // A progress line's description is what the task does now, not what it is.
  if (message.subtype === "task_progress") set("activity", str(message.description));
  else set("description", str(message.description));
  set("toolUseId", str(message.tool_use_id));
  set("subagentType", str(message.subagent_type));
  set("prompt", str(message.prompt));
  if (typeof message.is_backgrounded === "boolean") next.backgrounded = message.is_backgrounded;
  set("lastToolName", str(message.last_tool_name));
  const usage = rec(message.usage);
  set("totalTokens", num(usage?.total_tokens));
  set("toolUses", num(usage?.tool_uses));
  set("durationMs", num(usage?.duration_ms));
  const patch = rec(message.patch);
  const status = str(patch?.status) ?? str(message.status);
  if (status) next.status = status;
  set("endedAt", num(patch?.end_time));
  if (message.subtype === "task_notification") {
    set("summary", str(message.summary));
    set("outputFile", str(message.output_file));
    if (next.endedAt === undefined) next.endedAt = at;
  }
  m.tasks = { ...m.tasks, [id]: next };
}

/** The program ended: so did the tasks it ran. */
function stopRunningTasks(draft: Draft, at: number | undefined): void {
  const m = draft.next;
  let tasks: Record<string, TaskInfo> | null = null;
  for (const task of Object.values(m.tasks)) {
    if (task.status !== "running") continue;
    tasks ??= { ...m.tasks };
    tasks[task.taskId] = { ...task, status: "stopped", endedAt: task.endedAt ?? at };
  }
  if (tasks) m.tasks = tasks;
}

function applyStreamEvent(draft: Draft, message: Rec): void {
  // Subagents stream nothing; a parent id here is a teammate or a fork.
  if (message.parent_tool_use_id) return;
  const event = rec(message.event);
  if (!event) return;
  const m = draft.next;
  switch (event.type) {
    case "message_start": {
      const id = str(rec(event.message)?.id) ?? "";
      m.streaming = { messageId: id, blocks: {} };
      if (m.turn) m.turn = { ...m.turn, status: undefined, retry: undefined };
      return;
    }
    case "content_block_start": {
      const index = num(event.index);
      const block = rec(event.content_block);
      if (!m.streaming || index === undefined || !block) return;
      const type = str(block.type);
      if (type === "text" || type === "thinking") {
        m.streaming = {
          ...m.streaming,
          blocks: { ...m.streaming.blocks, [index]: { type, text: "" } },
        };
      } else if (type === "tool_use") {
        const id = str(block.id);
        const name = str(block.name) ?? "";
        m.streaming = {
          ...m.streaming,
          blocks: { ...m.streaming.blocks, [index]: { type, text: "", toolUseId: id } },
        };
        if (id) {
          draft.setTool(
            id,
            (prev) =>
              prev ?? {
                id,
                name,
                input: {},
                partialInput: "",
                status: "streaming",
                parentToolUseId: null,
              },
          );
        }
      }
      return;
    }
    case "content_block_delta": {
      const index = num(event.index);
      const delta = rec(event.delta);
      if (!m.streaming || index === undefined || !delta) return;
      const block = m.streaming.blocks[index];
      if (!block) return;
      let piece: string | undefined;
      if (delta.type === "text_delta") piece = str(delta.text);
      else if (delta.type === "thinking_delta") piece = str(delta.thinking);
      else if (delta.type === "input_json_delta") piece = str(delta.partial_json);
      if (!piece) return;
      const nextBlock = { ...block, text: block.text + piece };
      m.streaming = { ...m.streaming, blocks: { ...m.streaming.blocks, [index]: nextBlock } };
      if (
        block.type === "tool_use" &&
        block.toolUseId &&
        m.tools[block.toolUseId]?.status === "streaming"
      ) {
        const id = block.toolUseId;
        draft.setTool(id, (t) => ({ ...(t as ToolCall), partialInput: nextBlock.text }));
      }
      if (block.type === "text" && m.turn) {
        m.turn = { ...m.turn, outputTokens: m.turn.outputTokens + Math.ceil(piece.length / 4) };
      }
      return;
    }
    case "message_delta": {
      const output = num(rec(event.usage)?.output_tokens);
      if (m.turn && output !== undefined) m.turn = { ...m.turn, outputTokens: output };
      return;
    }
    case "message_stop":
      m.streaming = null;
      return;
  }
}

function applyAssistant(draft: Draft, message: Rec, seq: number, at: number | undefined): void {
  const m = draft.next;
  const body = rec(message.message);
  const content = Array.isArray(body?.content) ? body.content : [];
  const parent = str(message.parent_tool_use_id) ?? null;
  const messageId = str(body?.id) ?? `m${seq}`;
  const when = time(message.timestamp) ?? at;
  if (!parent && applyGoalCommand(draft, message, content, seq, when)) return;

  const blocks: AssistantBlock[] = [];
  for (const raw of content) {
    const block = rec(raw);
    if (!block) continue;
    if (block.type === "text") {
      const text = str(block.text) ?? "";
      if (text) blocks.push({ type: "text", text });
    } else if (block.type === "thinking") {
      const text = str(block.thinking) ?? "";
      if (text) blocks.push({ type: "thinking", text });
    } else if (block.type === "tool_use") {
      const id = str(block.id);
      if (!id) continue;
      const name = str(block.name) ?? "";
      draft.setTool(id, (prev) => ({
        id,
        name,
        input: block.input ?? {},
        status: prev && prev.status !== "streaming" ? prev.status : "running",
        result: prev?.result,
        parentToolUseId: parent,
      }));
      blocks.push({ type: "tool", toolUseId: id });
    }
  }
  // A subagent's messages belong to its Agent tool call, not the main thread.
  if (parent) {
    if (blocks.length > 0)
      pushAgentBlocks(draft, parent, messageId, str(message.uuid), blocks, when, seq);
    return;
  }

  // The block streamed so far has arrived whole.
  if (m.streaming && m.streaming.messageId === messageId)
    m.streaming = { ...m.streaming, blocks: {} };
  if (blocks.length === 0) return;

  const items = m.items;
  for (let i = items.length - 1; i >= 0 && i >= items.length - 8; i--) {
    const item = items[i];
    if (item.kind === "assistant" && item.messageId === messageId) {
      // Each block comes as a line of its own; the last one's uuid holds them all.
      draft.replaceItem(i, {
        ...item,
        blocks: [...item.blocks, ...blocks],
        uuid: str(message.uuid) ?? item.uuid,
      });
      return;
    }
    if (item.kind === "user") break;
  }
  draft.push({
    kind: "assistant",
    key: `a${seq}`,
    messageId,
    uuid: str(message.uuid),
    blocks,
    at: when,
  });
}

function pushAgentBlocks(
  draft: Draft,
  parent: string,
  messageId: string,
  uuid: string | undefined,
  blocks: AssistantBlock[],
  at: number | undefined,
  seq: number,
): void {
  const m = draft.next;
  const items = m.agentItems[parent] ?? [];
  const last = items[items.length - 1];
  const next =
    last && last.messageId === messageId
      ? [
          ...items.slice(0, -1),
          { ...last, blocks: [...last.blocks, ...blocks], uuid: uuid ?? last.uuid },
        ]
      : [...items, { kind: "assistant" as const, key: `a${seq}`, messageId, uuid, blocks, at }];
  m.agentItems = { ...m.agentItems, [parent]: next };
}

/**
 * A command's output, as the CLI writes it in a user message: it went to
 * the user, not the model. Claude 2.1.319 echoes one once a session has
 * started when the tab sets the model (set_model, or apply_flag_settings
 * with a model: "Set model to ..."), and after /compact ("Compacted"),
 * which its own notice tells.
 */
export function isCommandOutput(text: string): boolean {
  return text.startsWith("<local-command-stdout>") || text.startsWith("<local-command-stderr>");
}

/**
 * A command the user ran, as the CLI writes it
 * (`<command-name>/clear</command-name>…<command-args>…`), written as typed;
 * null for any other text.
 */
export function typedCommand(text: string): string | null {
  const name = /^\s*<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) return null;
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
  const typed = name.startsWith("/") ? name : `/${name}`;
  return args ? `${typed} ${args}` : typed;
}

function applyUserOut(
  draft: Draft,
  message: Rec,
  seq: number,
  at: number | undefined,
  live: boolean,
): void {
  const m = draft.next;
  const body = rec(message.message);
  const content = body?.content;
  const when = time(message.timestamp) ?? at;

  // A check that found the goal unmet, which Claude reads to go on: not
  // the user's message, though it comes as one.
  if (!message.parent_tool_use_id && applyGoalFeedback(draft, message, content, when)) return;

  if (message.isReplay === true) {
    const said = userContent(content).text;
    // Echoed as a message taken, it is none the app wrote: shown, it would
    // read as the user's, and take a message the user wrote for its own.
    if (isCommandOutput(said)) return;
    const command = typedCommand(said);
    // /clear's echo comes after the reset that took the message it was typed
    // as, and would take another one for its own: the reset's notice tells it.
    if (command === "/clear") return;
    // The CLI took a message the app wrote: the one it was written with
    // this uuid, else the oldest one not yet taken.
    const uuid = str(message.uuid);
    const sent = (item: ChatItem) => item.kind === "user" && item.state === "sent";
    let index = uuid
      ? m.items.findIndex((item) => sent(item) && (item as UserItem).sentUuid === uuid)
      : -1;
    // One the app did not write may be no message of the user's at all: a
    // shell command run in the terminal, which no turn follows.
    if (index < 0 && applyShell(draft, said, seq, when)) return;
    const other = index < 0 ? notTheUsers(message, said) : null;
    if (!other && index < 0) index = m.items.findIndex(sent);
    // Taken live after a turn ended, it begins the next one: one the user
    // sent as the last turn was ending, or one the CLI was given itself
    // (Remote Control, a background task's news). A transcript's messages
    // come the same way, with no turn's end after them.
    if (live && !m.running && m.process === "running") {
      m.running = true;
      m.turn = { startedAt: when, outputTokens: 0, thinkingTokens: 0 };
    }
    if (other) {
      // A task's end is told live by the CLI's own notice of it (applyTaskEnd).
      if (other.kind === "task") {
        if (message.fromTranscript === true) {
          pushTaskEnd(draft, taskNews(said), when, message.midTurn !== true);
        }
      } else if (other.kind === "from") {
        draft.push({
          kind: "received",
          key: `r${seq}`,
          uuid,
          from: other.from,
          text: other.text,
          at: when,
        });
      }
      return;
    }
    if (index >= 0) {
      const { queued, ...item } = m.items[index] as UserItem;
      const taken: UserItem = { ...item, state: "taken", uuid, at: item.at ?? when };
      if (queued) {
        // One that waited is read here, after what the turn did meanwhile.
        draft.removeItem(index);
        draft.push({ ...taken, at: when ?? item.at });
      } else {
        draft.replaceItem(index, taken);
      }
    } else {
      // A command the CLI was given itself (Remote Control) reads as typed.
      const { text, images } = userContent(content);
      draft.push({
        kind: "user",
        key: `u${seq}`,
        text: command ?? text,
        images,
        state: "taken",
        uuid,
        at: when,
      });
    }
    return;
  }

  if (!Array.isArray(content)) return;
  const structured = message.tool_use_result;
  for (const raw of content) {
    const block = rec(raw);
    if (!block) continue;
    if (block.type === "tool_result") {
      const id = str(block.tool_use_id);
      if (!id) continue;
      const result = toolResult(block, structured);
      draft.setTool(id, (prev) => ({
        id,
        name: prev?.name ?? "",
        input: prev?.input ?? {},
        parentToolUseId: prev?.parentToolUseId ?? str(message.parent_tool_use_id) ?? null,
        status:
          prev?.status === "denied"
            ? "denied"
            : prev?.status === "stopped" || (result.isError && m.interrupting)
              ? "stopped"
              : result.isError
                ? "error"
                : "done",
        result,
      }));
    } else if (block.type === "text" && !message.parent_tool_use_id) {
      const text = str(block.text) ?? "";
      if (text.startsWith("[Request interrupted")) {
        draft.push({ kind: "notice", key: `n${seq}`, code: "interrupted", at: when });
      }
    }
  }
}

function applyResult(draft: Draft, message: Rec, seq: number, at: number | undefined): void {
  const m = draft.next;
  const subtype = str(message.subtype) ?? "success";
  const isError = message.is_error === true || subtype !== "success";
  const terminalReason = str(message.terminal_reason);
  m.running = false;
  m.turn = null;
  m.streaming = null;
  m.interrupting = false;
  const cost = num(message.total_cost_usd);
  if (cost !== undefined) {
    m.costUsd = (m.costUsd ?? 0) - (m.processCostUsd ?? 0) + cost;
    m.processCostUsd = cost;
  }
  m.lastResult = {
    subtype,
    isError,
    durationMs: num(message.duration_ms),
    numTurns: num(message.num_turns),
    costUsd: num(message.total_cost_usd),
    terminalReason,
  };
  const interrupted =
    terminalReason === "aborted_tools" ||
    terminalReason === "aborted_streaming" ||
    terminalReason === "interrupted";
  if (interrupted) stopRunningTools(draft);
  if (isError && !interrupted) {
    const errors = Array.isArray(message.errors)
      ? message.errors.filter((e) => typeof e === "string")
      : [];
    const detail = str(message.result) ?? (errors.length > 0 ? errors.join("\n") : subtype);
    draft.push({ kind: "notice", key: `n${seq}`, code: "error", detail, at });
  }
}

/**
 * /goal's own output, which Claude Code writes as a message of its own: a
 * goal set or cleared is the tab's goal, and a notice in the conversation.
 * Its other answers ("Goal active: …", "No goal set") show as they are.
 */
function applyGoalCommand(
  draft: Draft,
  message: Rec,
  content: unknown[],
  seq: number,
  at: number | undefined,
): boolean {
  const run = rec(message.local_command_run);
  if (run?.command !== "goal") return false;
  const m = draft.next;
  const text = userContent(content).text.trim();
  const set = /^Goal set: ([\s\S]+)$/.exec(text);
  if (set) {
    // As typed: the output may cut a long one short.
    const condition = str(run.args)?.trim() || set[1].trim();
    m.goal = { condition, setAt: at, status: "active", checks: [] };
    draft.push({ kind: "notice", key: `n${seq}`, code: "goal_set", detail: condition, at });
    return true;
  }
  const cleared = /^Goal cleared: ([\s\S]+)$/.exec(text);
  if (cleared) {
    m.goal = null;
    draft.push({
      kind: "notice",
      key: `n${seq}`,
      code: "goal_cleared",
      detail: cleared[1].trim(),
      at,
    });
    return true;
  }
  if (text === "No goal set") m.goal = null;
  return false;
}

type NotTheUsers =
  | { kind: "task" }
  | { kind: "from"; from: MessageSource; text: string }
  /** The CLI's own word to Claude (a reminder, a hook's, a skill's text). */
  | { kind: "hidden" };

/**
 * What a message the CLI took is, when the user did not write it: the CLI
 * says who did (origin) and marks what it wrote itself (isSynthetic). How
 * the text looks tells nothing: the user can paste any tag.
 */
function notTheUsers(message: Rec, said: string): NotTheUsers | null {
  const origin = rec(message.origin);
  const kind = str(origin?.kind);
  const own = message.isSynthetic === true;
  if (kind === "task-notification") return { kind: "task" };
  // Before the CLI named origins, its own notice of a task came bare.
  if (!kind && /^\s*<task-notification>/.test(said) && /<task-id>/.test(said)) {
    return { kind: "task" };
  }
  if (kind && SENDER_KINDS.has(kind)) return received(kind, origin, said);
  if (own) return { kind: "hidden" };
  if (!kind || USER_KINDS.has(kind)) return null;
  return received(kind, origin, said);
}

/** The origins of a message the user wrote: here, by voice, or from another device. */
const USER_KINDS: ReadonlySet<string> = new Set([
  "human",
  "composer",
  "remote",
  "voice-call",
  // The CLI could not tell whose: the user's, as it was before it told.
  "unclassified",
]);

/**
 * A message someone else sent, without the tag the CLI wraps it in for
 * Claude (`<cross-session-message from-name="…">`, `<agent-message from="…">`,
 * `<channel source="…">`) or the line it leads it with.
 */
function received(kind: string, origin: Rec | null, said: string): NotTheUsers {
  // The line the CLI leads it with, when it begins a turn ("Another Claude
  // session sent a message:", "The coordinator sent a message while…:").
  const body = said.replace(/^\s*[^\n<]{1,160}:\n(?=\s*<[a-z])/, "");
  const wrapped = /^\s*<([a-z][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*>\n?([\s\S]*?)\n?<\/\1>\s*$/.exec(
    body,
  );
  const attr = (name: string) =>
    wrapped ? new RegExp(`\\s${name}="([^"]*)"`).exec(wrapped[2])?.[1] : undefined;
  const name =
    str(origin?.name) ??
    attr("from-name") ??
    str(origin?.server) ??
    attr("source") ??
    attr("from") ??
    str(origin?.from);
  let text = wrapped ? wrapped[3] : said;
  if (kind === "coordinator")
    text = text.replace(/^\s*The coordinator sent a message[^\n]*:\n/, "");
  return { kind: "from", from: name ? { kind, name } : { kind }, text: text.trim() };
}

/** What a task's end says of it, as the CLI writes it for Claude (`<task-notification>`). */
function taskNews(said: string): Rec {
  const tag = (name: string) =>
    new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(said)?.[1]?.trim() || undefined;
  return {
    task_id: tag("task-id"),
    tool_use_id: tag("tool-use-id"),
    status: tag("status"),
    summary: tag("summary"),
  };
}

/**
 * The CLI's notice that a task ended. One Claude waited for (a subagent it
 * ran in the turn) ends with its call's result, which shows it; one it did
 * not wait for has had that result since it began, and gets a line here.
 */
function applyTaskEnd(draft: Draft, message: Rec, at: number | undefined): void {
  const toolUseId = str(message.tool_use_id);
  const call = toolUseId ? draft.next.tools[toolUseId] : undefined;
  if (call && !call.result) return;
  pushTaskEnd(draft, message, at, !draft.next.running);
}

function pushTaskEnd(draft: Draft, news: Rec, at: number | undefined, wakes: boolean): void {
  const m = draft.next;
  const taskId = str(news.task_id);
  const status = str(news.status);
  if (!taskId || !status) return;
  const key = `te-${taskId}`;
  if (m.items.some((item) => item.key === key)) return;
  const task = m.tasks[taskId];
  draft.push({
    kind: "task_end",
    key,
    taskId,
    status,
    description: task?.description || undefined,
    taskType: task?.type || undefined,
    summary: str(news.summary),
    toolUseId: str(news.tool_use_id) ?? task?.toolUseId,
    ...(wakes ? { wakes } : {}),
    at,
  });
}

/**
 * A shell command the user ran in the terminal's Claude Code (`!command`),
 * as the CLI keeps it: `<bash-input>` and then `<bash-stdout>…<bash-stderr>`.
 */
function applyShell(draft: Draft, said: string, seq: number, at: number | undefined): boolean {
  const m = draft.next;
  const input = /^\s*<bash-input>([\s\S]*)<\/bash-input>\s*$/.exec(said);
  if (input) {
    draft.push({ kind: "shell", key: `sh${seq}`, command: input[1].trim(), at });
    return true;
  }
  if (!/^\s*<bash-(stdout|stderr)>/.test(said)) return false;
  const part = (name: string) =>
    new RegExp(`<bash-${name}>([\\s\\S]*?)</bash-${name}>`).exec(said)?.[1]?.replace(/\s+$/, "") ||
    undefined;
  const last = m.items.length - 1;
  const prev = m.items[last];
  const out = { stdout: part("stdout"), stderr: part("stderr") };
  if (prev?.kind === "shell" && prev.stdout === undefined && prev.stderr === undefined) {
    draft.replaceItem(last, { ...prev, ...out });
  } else {
    draft.push({ kind: "shell", key: `sh${seq}`, command: "", ...out, at });
  }
  return true;
}

/**
 * A check that found the goal unmet ("Stop hook feedback: [condition]: why"),
 * which Claude reads as a message to go on. True when the message is one, of
 * the goal's or of another Stop hook's: none is the user's to show.
 */
function applyGoalFeedback(draft: Draft, message: Rec, content: unknown, at: number | undefined) {
  const said = userContent(content).text;
  if (!said.startsWith("Stop hook feedback:")) return false;
  const goal = draft.next.goal;
  const reason = goal?.status === "active" ? goalFeedbackReason(said, goal.condition) : null;
  if (goal && reason !== null) {
    draft.next.goal = { ...goal, checks: [...goal.checks, { at, reason }] };
    return true;
  }
  return message.isSynthetic === true;
}

/**
 * A goal's check as the transcript keeps it (history.ts makes it a line):
 * one that found the goal unmet, or the one that ended it met or failed.
 */
function applyGoalStatus(draft: Draft, message: Rec, seq: number, at: number | undefined): void {
  const condition = str(message.condition);
  if (!condition || message.sentinel === true) return;
  const m = draft.next;
  const when = time(message.timestamp) ?? at;
  const reason = str(message.reason);
  // A goal set before the part of the transcript read is taken from its checks.
  const goal: ClaudeGoal =
    m.goal?.condition === condition ? m.goal : { condition, status: "active", checks: [] };
  if (goal.status !== "active") return;
  const met = message.met === true;
  if (met || message.failed === true) {
    m.goal = {
      ...goal,
      status: met ? "met" : "failed",
      reason,
      iterations: num(message.iterations),
      durationMs: num(message.durationMs),
      tokens: num(message.tokens),
      endedAt: when,
    };
    draft.push(goalEndNotice(m.goal, `n${seq}`));
  } else if (reason) {
    m.goal = { ...goal, checks: [...goal.checks, { at: when, reason }] };
  }
}

function goalEndNotice(goal: ClaudeGoal, key: string): NoticeItem {
  const met = goal.status === "met";
  return {
    kind: "notice",
    key,
    code: met ? "goal_met" : "goal_failed",
    detail: met ? goal.condition : (goal.reason ?? goal.condition),
    at: goal.endedAt,
  };
}

/**
 * The model once the transcript told that its goal ended: a check that finds
 * it met (or impossible) ends the turn without a word in the stream. The
 * goal takes what the transcript told, and the conversation a notice where
 * it ended.
 */
export function endGoal(model: ChatModel, told: ClaudeGoal): ChatModel {
  const goal = model.goal;
  if (!goal || goal.status !== "active" || told.status === "active") return model;
  if (told.condition !== goal.condition) return model;
  const ended: ClaudeGoal = {
    ...told,
    setAt: goal.setAt ?? told.setAt,
    checks: told.checks.length >= goal.checks.length ? told.checks : goal.checks,
    endedLive: true,
  };
  const items = [...model.items];
  let index = items.length;
  const endedAt = ended.endedAt;
  if (endedAt !== undefined) {
    while (index > 0 && (items[index - 1].at ?? 0) > endedAt) index--;
  }
  items.splice(index, 0, goalEndNotice(ended, `goal-end-${endedAt ?? goal.setAt ?? ""}`));
  return { ...model, items, goal: ended };
}

function applyControlRequest(draft: Draft, message: Rec): void {
  const id = str(message.request_id);
  const request = rec(message.request);
  if (!id || !request || request.subtype !== "can_use_tool") return;
  const m = draft.next;
  if (m.permissions.some((p) => p.requestId === id)) return;
  m.permissions = [
    ...m.permissions,
    {
      requestId: id,
      toolName: str(request.tool_name) ?? "",
      displayName: str(request.display_name),
      input: rec(request.input) ?? {},
      description: str(request.description),
      suggestions: Array.isArray(request.permission_suggestions)
        ? request.permission_suggestions
        : [],
      decisionReason: str(request.decision_reason),
      toolUseId: str(request.tool_use_id),
      agentId: str(request.agent_id),
    },
  ];
}

/** Requests the app makes on its own, whose errors are not the conversation's. */
const QUIET_REQUESTS = new Set([
  "get_context_usage",
  "get_usage",
  "mcp_status",
  "file_suggestions",
  // /config and /sandbox show its error themselves.
  "get_settings",
]);

function applyControlResponse(
  draft: Draft,
  message: Rec,
  seq: number,
  at: number | undefined,
): void {
  const m = draft.next;
  const response = rec(message.response);
  const id = str(response?.request_id);
  // The CLI echoes the app's answers to its own requests too: ids it gave.
  if (!id || !m.outgoing[id]) return;
  const { subtype, request } = m.outgoing[id];
  const { [id]: _done, ...rest } = m.outgoing;
  m.outgoing = rest;
  if (response?.subtype === "error") {
    // The side panel's reads fail quietly: it shows what it has.
    if (QUIET_REQUESTS.has(subtype)) return;
    const error = str(response.error) ?? subtype;
    if (subtype === "set_permission_mode" && request.mode === "bypassPermissions") {
      m.bypassBlocked = error;
    }
    draft.push({ kind: "notice", key: `n${seq}`, code: "error", detail: error, at });
    return;
  }
  const body = rec(response?.response) ?? {};
  switch (subtype) {
    case "initialize": {
      m.init = {
        commands: Array.isArray(body.commands)
          ? (body.commands.filter((c) => rec(c) && str(rec(c)?.name)) as CommandInfo[])
          : [],
        models: Array.isArray(body.models)
          ? (body.models.filter((x) => rec(x) && str(rec(x)?.value)) as ModelInfo[])
          : [],
        remoteControl: body.remote_control_available === true,
        outputStyles: Array.isArray(body.available_output_styles)
          ? body.available_output_styles.filter((s): s is string => typeof s === "string")
          : undefined,
        account: accountOf(rec(body.account)),
      };
      m.permissionMode = str(body.current_permission_mode) ?? m.permissionMode;
      m.version = str(body.claude_code_version) ?? m.version;
      return;
    }
    case "set_permission_mode":
      // The first switch of a process sends no system/status: the answer says.
      m.permissionMode = str(body.mode) ?? str(request.mode) ?? m.permissionMode;
      return;
    case "set_model":
      m.model = str(request.model) ?? m.model;
      m.chosenModel = str(request.model) ?? m.chosenModel;
      return;
    case "apply_flag_settings": {
      const effort = str(rec(request.settings)?.effortLevel);
      if (effort) m.effort = effort;
      return;
    }
    case "get_settings":
      // Before its first turn the session names no model, nor ever its effort.
      m.model ??= settingsModel(body);
      m.chosenModel ??= settingsChoice(body);
      m.effort ??= appliedEffort(body);
      return;
    case "get_context_usage":
      m.contextUsage = body;
      return;
    case "get_usage": {
      // A usage endpoint that failed (a 429 among them) still answers, with
      // no limits: the last answer that had them stays.
      const limits = rec(body.rate_limits)?.limits;
      if (!m.usage || (Array.isArray(limits) && limits.length > 0)) m.usage = body;
      return;
    }
    case "mcp_status":
      m.mcp = Array.isArray(body.mcpServers)
        ? body.mcpServers.flatMap((raw) => {
            const server = rec(raw);
            const name = str(server?.name);
            if (!server || !name) return [];
            return [
              {
                name,
                status: str(server.status) ?? "",
                scope: str(server.scope),
                transport: str(server.transport),
              },
            ];
          })
        : [];
      return;
    case "remote_control":
      m.remoteControl =
        request.enabled === true
          ? { enabled: true, sessionUrl: str(body.session_url) }
          : { enabled: false };
      return;
  }
}

function accountOf(account: Rec | null): AccountInfo | undefined {
  if (!account) return undefined;
  const info: AccountInfo = {
    email: str(account.email),
    organization: str(account.organization),
    subscription: str(account.subscriptionType),
    provider: str(account.apiProvider),
  };
  return Object.values(info).some(Boolean) ? info : undefined;
}

export function stopRunningTools(draft: Draft): void {
  for (const tool of Object.values(draft.next.tools)) {
    if (tool.status === "running" || tool.status === "streaming") {
      draft.setTool(tool.id, (t) => ({ ...(t as ToolCall), status: "stopped" }));
    }
  }
}

function userContent(content: unknown): { text: string; images: ImageBlock[] } {
  if (typeof content === "string") return { text: content, images: [] };
  const texts: string[] = [];
  const images: ImageBlock[] = [];
  if (Array.isArray(content)) {
    for (const raw of content) {
      const block = rec(raw);
      if (block?.type === "text") texts.push(str(block.text) ?? "");
      else if (block?.type === "image") {
        const image = imageBlock(block);
        if (image) images.push(image);
      }
    }
  }
  return { text: texts.join("\n"), images };
}

function imageBlock(block: Rec): ImageBlock | null {
  const source = rec(block.source);
  const data = str(source?.data);
  if (source?.type !== "base64" || !data) return null;
  return { mediaType: str(source.media_type) ?? "image/png", data };
}

function toolResult(block: Rec, structured: unknown): ToolResult {
  const isError = block.is_error === true;
  const content = block.content;
  const images: ImageBlock[] = [];
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const raw of content) {
      const part = rec(raw);
      if (part?.type === "text") parts.push(str(part.text) ?? "");
      else if (part?.type === "image") {
        const image = imageBlock(part);
        if (image) images.push(image);
      }
    }
    text = parts.join("\n");
  }
  return { text, isError, ...(structured !== undefined ? { structured } : {}), images };
}
