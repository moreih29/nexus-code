import type { ClaudeTurnResult } from "../../../shared/claude/turn-result";
import { terminalText } from "../editor/preview/notebook";
import type { RetryReason, TurnFailure } from "./api-errors";
import type { ClaudeGoal } from "./goal";

export type LineDir = "out" | "in" | "sys";

export interface ChatLine {
  seq: number;
  dir: LineDir;
  message?: unknown;
  text?: string;
  at?: number;
  replay?: boolean;
}

export interface ImageBlock {
  mediaType: string;
  data: string;
  remote?: RemoteImageRef;
}

export type RemoteImageRef =
  | { kind: "user"; itemKey: string; index: number }
  | { kind: "tool"; toolUseId: string; index: number }
  | { kind: "held"; id: string; index: number };

export function remoteImageKey(ref: RemoteImageRef): string {
  const id = ref.kind === "user" ? ref.itemKey : ref.kind === "tool" ? ref.toolUseId : ref.id;
  return JSON.stringify([ref.kind, id, ref.index]);
}

export interface ChatMediaAccess {
  scope: string;
  signal: AbortSignal | null;
}

export interface ImageLoader {
  (image: ImageBlock): Promise<ImageBlock>;
  access: ChatMediaAccess | null;
  subscribe(ref: RemoteImageRef, listener: (image: ImageBlock | null) => void): () => void;
}

export interface UserItem {
  kind: "user";
  key: string;
  uuid?: string;
  text: string;
  images: ImageBlock[];
  state: "sent" | "taken";
  sentUuid?: string;
  clientNonce?: string;
  clientDeviceId?: string;
  peerWritePending?: boolean;
  optimistic?: {
    status: "sending" | "accepted" | "failed" | "unconfirmed";
    queued: boolean;
    fileNames: string[];
    submittedAt: number;
    error?: string;
  };
  queued?: boolean;
  turnId?: string;
  turnResult?: { error?: string };
  forkable?: boolean;
  rewindable?: boolean;
  at?: number;
}

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
  | "not_resumed"
  | "review"
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

export interface MessageSource {
  kind: string;
  name?: string;
  agent?: string;
  workspaceId?: string;
  tabId?: string;
  device?: { id: string; name: string };
}

export interface ReceivedItem {
  kind: "received";
  key: string;
  uuid?: string;
  from: MessageSource;
  text: string;
  at?: number;
}

export interface TaskEndItem {
  kind: "task_end";
  key: string;
  taskId: string;
  status: string;
  description?: string;
  taskType?: string;
  summary?: string;
  toolUseId?: string;
  wakes?: boolean;
  at?: number;
}

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
  structured?: unknown;
  images: ImageBlock[];
}

export interface ToolCall {
  id: string;
  name: string;
  displayName?: string;
  input: unknown;
  partialInput?: string;
  status: "streaming" | "running" | "done" | "error" | "denied" | "stopped";
  result?: ToolResult;
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
  agentId?: string;
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
  lastActivityAt?: number;
  outputTokens: number;
  thinkingTokens: number;
  status?: string;
  retry?: TurnRetry;
}

export interface TurnRetry {
  attempt: number;
  maxRetries?: number;
  delayMs?: number;
  at?: number;
  status?: number;
  reason?: RetryReason;
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

export function currentModelInfo(
  models: readonly ModelInfo[],
  current: string | undefined,
  chosen?: string,
): ModelInfo | undefined {
  if (!current) return models.find((m) => m.value === "default");
  const named =
    chosen && longContextBase(chosen) !== "default"
      ? models.filter((m) => m.value !== "default")
      : models;
  return modelInfoOf(named, current) ?? modelInfoOf(models, current);
}

function longContextBase(model: string): string {
  return model.replace(/\[[^\]]*\]$/, "");
}

function modelInfoOf(models: readonly ModelInfo[], current: string): ModelInfo | undefined {
  const base = longContextBase(current);
  return (
    models.find((m) => m.value === current) ??
    models.find((m) => m.resolvedModel === current) ??
    models.find((m) => m.value === base || m.resolvedModel === base) ??
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
  builtin?: boolean;
}

export interface InitializeInfo {
  commands: CommandInfo[];
  models: ModelInfo[];
  remoteControl: boolean;
  outputStyles?: string[];
  account?: AccountInfo;
}

export interface AccountInfo {
  email?: string;
  organization?: string;
  subscription?: string;
  provider?: string;
}

export interface ResultInfo {
  subtype: string;
  isError: boolean;
  turnId?: string;
  durationMs?: number;
  numTurns?: number;
  costUsd?: number;
  terminalReason?: string;
  outcome?: ClaudeTurnResult["outcome"];
  error?: string;
  failure?: TurnFailure;
  at?: number;
}

export interface TaskInfo {
  taskId: string;
  type: string;
  description: string;
  status: string;
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
  model?: string;
  chosenModel?: string;
  permissionMode?: string;
  confirmedPermissionMode?: string;
  effort?: string;
  cwd?: string;
  version?: string;
  init?: InitializeInfo;
  slashCommands?: CommandInfo[];
  running: boolean;
  turn: TurnState | null;
  process: "none" | "running" | "exited";
  exit?: { code: number | null; signal?: string; stderrTail?: string };
  lastResult?: ResultInfo;
  costUsd?: number;
  processCostUsd?: number;
  clears?: number;
  bypassBlocked?: string;
  rateLimit?: RateLimitInfo;
  contextUsage?: unknown;
  usage?: unknown;
  mcp?: McpServerInfo[];
  remoteControl?: { enabled: boolean; sessionUrl?: string };
  tasks: Record<string, TaskInfo>;
  agentItems: Record<string, AssistantItem[]>;
  interrupting?: boolean;
  interruptRequestId?: string;
  outgoing: Record<string, { subtype: string; request: Record<string, unknown> }>;
  resumed?: boolean;
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

export function applySys(draft: Draft, message: Rec, seq: number, at: number | undefined): void {
  const m = draft.next;
  switch (message.event) {
    case "start":
      if (m.process === "none" && m.items.length === 0) m.resumed = message.resumed === true;
      if (message.connectionChanged === true) {
        draft.push({ kind: "notice", key: `n${seq}`, code: "connection_restarted", at });
        m.init = undefined;
        m.slashCommands = undefined;
        m.model = undefined;
        m.chosenModel = undefined;
        m.effort = undefined;
        m.contextUsage = undefined;
      } else if (m.process === "exited")
        draft.push({ kind: "notice", key: `n${seq}`, code: "restarted", at });
      m.process = "running";
      m.confirmedPermissionMode = undefined;
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
      const stderr = str(message.stderrTail);
      const stderrTail = stderr === undefined ? undefined : terminalText(stderr);
      m.process = "exited";
      m.confirmedPermissionMode = undefined;
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
      m.confirmedPermissionMode = undefined;
      draft.push({ kind: "notice", key: `n${seq}`, code: "dropped", at });
      return;
  }
}

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
