// Conversation state and process log entries shared by the chat providers.

import type { ClaudeTurnResult } from "../../../shared/claude/turn-result";
import { terminalText } from "../editor/preview/notebook";
import type { ClaudeGoal } from "./goal";

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
  /**
   * Another computer's image, whose bytes stay there until it is shown
   * (chat.image): `data` is empty until then.
   */
  remote?: RemoteImageRef;
}

/**
 * Where another computer's chat has an image: a message's, a tool's
 * result's, or a message's held there for after the turn.
 */
export type RemoteImageRef =
  | { kind: "user"; itemKey: string; index: number }
  | { kind: "tool"; toolUseId: string; index: number }
  | { kind: "held"; id: string; index: number };

export interface ImageLoader {
  (image: ImageBlock): Promise<ImageBlock>;
  subscribe(ref: RemoteImageRef, listener: (image: ImageBlock | null) => void): () => void;
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
  clientNonce?: string;
  clientDeviceId?: string;
  /** Internal projection of a provisional host stdin write. */
  peerWritePending?: boolean;
  /** Local preview of a send to another device. Never included on the wire. */
  optimistic?: {
    status: "sending" | "accepted" | "failed" | "unconfirmed";
    queued: boolean;
    fileNames: string[];
    submittedAt: number;
    error?: string;
  };
  /**
   * Written during a turn: the CLI reads it after the tool it runs, and till
   * then it waits above the box, where it can still be taken back.
   */
  queued?: boolean;
  /** The turn that read this message. */
  turnId?: string;
  /** The outcome of that turn, kept so a wait can finish after newer turns. */
  turnResult?: { error?: string };
  forkable?: boolean;
  rewindable?: boolean;
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
  /** Claude's turn, which can contain several assistant messages. */
  turnId?: string;
  uuid?: string;
  blocks: AssistantBlock[];
  forkable?: boolean;
  at?: number;
}

export type NoticeCode =
  | "interrupted"
  | "exited"
  | "restarted"
  | "connection_restarted"
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
  id?: string;
  startedAt?: number;
  /** Last progress from the main conversation, in milliseconds. */
  lastActivityAt?: number;
  outputTokens: number;
  thinkingTokens: number;
  /** requesting: waiting on the API; compacting: /compact runs. */
  status?: string;
  retry?: { attempt: number; maxRetries?: number; delayMs?: number };
}

export function noteTurnActivity(model: ChatModel, at: number | undefined): void {
  const turn = model.turn;
  if (turn && at !== undefined && at > (turn.lastActivityAt ?? -Infinity)) {
    model.turn = { ...turn, lastActivityAt: at };
  }
}

export interface ModelInfo {
  value: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportedEffortLevels?: string[];
  isDefault?: boolean;
  serviceTiers?: string[];
  fastTier?: { id: string; description?: string; isDefault: boolean };
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
  outcome?: ClaudeTurnResult["outcome"];
  error?: string;
  /** When the turn ended, in Unix milliseconds. */
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
  /**
   * get_context_usage's last answer, its total moved on by each of the
   * main thread's API calls since (withContextTokens).
   */
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
  /** The currently pending interrupt by its protocol request ID. */
  interruptRequestId?: string;
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

export type Rec = Record<string, unknown>;

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

/** A draft of the model that copies what it changes, once. */
export class Draft<M extends ChatModel = ChatModel> {
  readonly next: M;
  private itemsCopied = false;
  private toolsCopied = false;

  constructor(
    prev: M,
    readonly matchSentInputs = true,
  ) {
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

/** The agent's own lines: the program started, exited, or the log dropped lines. */
export function applySys(draft: Draft, message: Rec, seq: number, at: number | undefined): void {
  const m = draft.next;
  switch (message.event) {
    case "start":
      if (m.process === "none" && m.items.length === 0) m.resumed = message.resumed === true;
      if (message.connectionChanged === true) {
        draft.push({ kind: "notice", key: `n${seq}`, code: "connection_restarted", at });
        m.init = undefined;
        m.model = undefined;
        m.chosenModel = undefined;
        m.effort = undefined;
        m.contextUsage = undefined;
      } else if (m.process === "exited")
        draft.push({ kind: "notice", key: `n${seq}`, code: "restarted", at });
      m.process = "running";
      m.processCostUsd = 0;
      m.exit = undefined;
      m.outgoing = {};
      m.permissions = [];
      m.running = false;
      m.turn = null;
      m.streaming = null;
      clearInterrupt(m);
      return;
    case "exit": {
      const code = num(message.code) ?? null;
      const signal = str(message.signal);
      // What the program wrote to a terminal: Codex colours its log lines.
      const stderr = str(message.stderrTail);
      const stderrTail = stderr === undefined ? undefined : terminalText(stderr);
      m.process = "exited";
      finishSubmittedTurn(draft, m.turn?.id, "the program exited");
      m.exit = { code, ...(signal ? { signal } : {}), ...(stderrTail ? { stderrTail } : {}) };
      m.running = false;
      m.turn = null;
      m.streaming = null;
      clearInterrupt(m);
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

/** The program ended: so did the tasks it ran. */
export function stopRunningTasks(draft: Draft, at: number | undefined): void {
  const m = draft.next;
  let tasks: Record<string, TaskInfo> | null = null;
  for (const task of Object.values(m.tasks)) {
    if (task.status !== "running") continue;
    tasks ??= { ...m.tasks };
    tasks[task.taskId] = { ...task, status: "stopped", endedAt: task.endedAt ?? at };
  }
  if (tasks) m.tasks = tasks;
}

/** Remembers how a turn ended on the accepted messages it read. */
export function finishSubmittedTurn(
  draft: Draft,
  turnId: string | undefined,
  error?: string,
): void {
  if (!turnId) return;
  const items = draft.next.items;
  const turnResult = error ? { error } : {};
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item.kind !== "user" || item.state !== "taken") continue;
    if (item.turnId === turnId) draft.replaceItem(index, { ...item, turnResult });
    else if (item.turnResult) break;
  }
}

/** Clears a pending interrupt when its request or turn ends. */
export function clearInterrupt(model: ChatModel, requestId?: string): void {
  if (requestId !== undefined && model.interruptRequestId !== requestId) return;
  model.interrupting = false;
  model.interruptRequestId = undefined;
}

export function stopRunningTools(
  draft: Draft,
  isForeground: (tool: ToolCall) => boolean = () => true,
): void {
  for (const tool of Object.values(draft.next.tools)) {
    if ((tool.status === "running" || tool.status === "streaming") && isForeground(tool)) {
      draft.setTool(tool.id, (t) => ({ ...(t as ToolCall), status: "stopped" }));
    }
  }
}
