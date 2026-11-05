// The conversation a Claude tab shows, rebuilt from the lines of its
// program's log: what `claude -p --output-format stream-json` wrote (out),
// what the app wrote it (in), and the agent's own start and exit (sys).
//
// applyLine is a pure reducer, so the same lines give the same view live
// and when a reloaded window replays the log. Fields Claude Code adds in
// later versions are ignored, and every field it may leave out is read as
// maybe absent: the protocol grows across 2.1.x releases (#159).

export type LineDir = "out" | "in" | "sys";

export interface ChatLine {
  seq: number;
  dir: LineDir;
  message?: unknown;
  text?: string;
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
  at?: number;
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

export type NoticeCode = "interrupted" | "exited" | "restarted" | "compacted" | "error" | "dropped";

export interface NoticeItem {
  kind: "notice";
  key: string;
  code: NoticeCode;
  detail?: string;
  at?: number;
}

export type ChatItem = UserItem | AssistantItem | NoticeItem;

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

export interface CommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
}

export interface InitializeInfo {
  commands: CommandInfo[];
  models: ModelInfo[];
}

export interface ResultInfo {
  subtype: string;
  isError: boolean;
  durationMs?: number;
  numTurns?: number;
  costUsd?: number;
  terminalReason?: string;
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
  /** What the session has cost, as its last result tells. */
  costUsd?: number;
  rateLimit?: RateLimitInfo;
  contextUsage?: unknown;
  /** The app asked the turn to stop: its tools' errors are the stop. */
  interrupting?: boolean;
  /** The app's control requests waiting for an answer: request id → subtype and request. */
  outgoing: Record<string, { subtype: string; request: Record<string, unknown> }>;
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
  };
}

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function time(value: unknown): number | undefined {
  const text = str(value);
  if (text === undefined) return undefined;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : ms;
}

/** A draft of the model that copies what it changes, once. */
class Draft {
  readonly next: ChatModel;
  private itemsCopied = false;
  private toolsCopied = false;

  constructor(prev: ChatModel) {
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
}

/** Applies one line to the model. Lines at or before lastSeq are skipped. */
export function applyLine(prev: ChatModel, line: ChatLine, now: number = Date.now()): ChatModel {
  if (line.seq <= prev.lastSeq) return prev;
  const draft = new Draft(prev);
  draft.next.lastSeq = line.seq;
  const message = rec(line.message);
  if (!message) return draft.next;
  // A replayed line has no time of its own; live ones happen now.
  const at = line.replay ? undefined : now;
  if (line.dir === "sys") applySys(draft, message, line.seq, at);
  else if (line.dir === "in") applyIn(draft, message, line.seq, at);
  else applyOut(draft, message, line.seq, at);
  return draft.next;
}

export function applyLines(prev: ChatModel, lines: readonly ChatLine[], now?: number): ChatModel {
  let model = prev;
  for (const line of lines) model = applyLine(model, line, now);
  return model;
}

function applySys(draft: Draft, message: Rec, seq: number, at: number | undefined): void {
  const m = draft.next;
  switch (message.event) {
    case "start":
      if (m.process === "exited")
        draft.push({ kind: "notice", key: `n${seq}`, code: "restarted", at });
      m.process = "running";
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
      const stderrTail = str(message.stderrTail);
      m.process = "exited";
      m.exit = { code, ...(signal ? { signal } : {}), ...(stderrTail ? { stderrTail } : {}) };
      m.running = false;
      m.turn = null;
      m.streaming = null;
      m.permissions = [];
      m.outgoing = {};
      stopRunningTools(draft);
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
      draft.push({ kind: "user", key: `u${seq}`, text, images, state: "sent", at });
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

function applyOut(draft: Draft, message: Rec, seq: number, at: number | undefined): void {
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
      applyUserOut(draft, message, seq, at);
      return;
    case "result":
      applyResult(draft, message, seq, at);
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
  }
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
  if (parent) return;

  // The block streamed so far has arrived whole.
  if (m.streaming && m.streaming.messageId === messageId)
    m.streaming = { ...m.streaming, blocks: {} };
  if (blocks.length === 0) return;

  const items = m.items;
  for (let i = items.length - 1; i >= 0 && i >= items.length - 8; i--) {
    const item = items[i];
    if (item.kind === "assistant" && item.messageId === messageId) {
      draft.replaceItem(i, { ...item, blocks: [...item.blocks, ...blocks] });
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

function applyUserOut(draft: Draft, message: Rec, seq: number, at: number | undefined): void {
  const m = draft.next;
  const body = rec(message.message);
  const content = body?.content;
  const when = time(message.timestamp) ?? at;

  if (message.isReplay === true) {
    // The CLI took a message the app wrote: the oldest one not yet taken.
    const uuid = str(message.uuid);
    const index = m.items.findIndex((item) => item.kind === "user" && item.state === "sent");
    if (index >= 0) {
      const item = m.items[index] as UserItem;
      draft.replaceItem(index, { ...item, state: "taken", uuid, at: item.at ?? when });
    } else {
      const { text, images } = userContent(content);
      draft.push({ kind: "user", key: `u${seq}`, text, images, state: "taken", uuid, at: when });
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
  m.costUsd = num(message.total_cost_usd) ?? m.costUsd;
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
    const error = str(response.error) ?? subtype;
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
      return;
    case "apply_flag_settings": {
      const effort = str(rec(request.settings)?.effortLevel);
      if (effort) m.effort = effort;
      return;
    }
    case "get_context_usage":
      m.contextUsage = body;
      return;
  }
}

function stopRunningTools(draft: Draft): void {
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

/** The user message uuids the CLI took, for rewind and fork. */
export function takenUserUuids(model: ChatModel): string[] {
  const uuids: string[] = [];
  for (const item of model.items) if (item.kind === "user" && item.uuid) uuids.push(item.uuid);
  return uuids;
}
