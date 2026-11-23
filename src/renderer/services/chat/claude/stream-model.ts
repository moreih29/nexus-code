// The conversation a Claude tab shows, rebuilt from the lines of its
// program's log: what `claude -p --output-format stream-json` wrote (out),
// what the app wrote it (in), and the agent's own start and exit (sys).
//
// applyLine is a pure reducer, so the same lines give the same view live
// and when a reloaded window replays the log. Fields Claude Code adds in
// later versions are ignored, and every field it may leave out is read as
// maybe absent: the protocol grows across 2.1.x releases (#159).

import { claudeTurnResult } from "../../../../shared/claude/turn-result";
import { claudeTurnFailure, retryReasonOf } from "../api-errors";
import { type ClaudeGoal, goalFeedbackReason } from "../goal";
import {
  type AccountInfo,
  type AssistantBlock,
  applySys,
  type ChatItem,
  type ChatLine,
  type ChatModel,
  type CommandInfo,
  clearInterrupt,
  Draft,
  emptyModel,
  finishSubmittedTurn,
  type ImageBlock,
  isWaiting,
  type MessageSource,
  type ModelInfo,
  type NoticeItem,
  noteTurnActivity,
  num,
  type Rec,
  rec,
  stopRunningTools,
  str,
  type TaskInfo,
  type ToolCall,
  type ToolResult,
  type UserItem,
} from "../model";
import { appliedEffort, settingsChoice, settingsModel } from "./settings-defaults";
import { usageLimitsOf } from "./usage-limits";

/** A transcript entry normalized for playback from an empty model. */
export type TranscriptLine = ChatLine & { dir: "out"; replay: true };

/** The origins of a message that is someone's, though not the user's: shown even when the CLI marks it its own. */
export const SENDER_KINDS: ReadonlySet<string> = new Set(["peer", "channel", "coordinator"]);

function time(value: unknown): number | undefined {
  const text = str(value);
  if (text === undefined) return undefined;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : ms;
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
  return reduceLines(prev, lines, now, true);
}

/** Reconstructs a transcript from recorded output, which cannot contain pending app input. */
export function applyTranscriptLines(lines: readonly TranscriptLine[]): ChatModel {
  return reduceLines(emptyModel(), lines, undefined, false);
}

/** Applies one batch with the input matching policy of its source. */
function reduceLines(
  prev: ChatModel,
  lines: readonly ChatLine[],
  now: number | undefined,
  matchSentInputs: boolean,
): ChatModel {
  let draft: Draft | undefined;
  for (const line of lines) {
    if (line.seq <= (draft?.next ?? prev).lastSeq) continue;
    draft ??= new Draft(prev, matchSentInputs);
    applyLineTo(draft, line, now ?? Date.now());
  }
  return draft?.next ?? prev;
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
        m.turn = { id: `claude-${seq}`, startedAt: at, outputTokens: 0, thinkingTokens: 0 };
        noteTurnActivity(m, at);
      }
      return;
    }
    case "control_request": {
      const id = str(message.request_id);
      const request = rec(message.request);
      const subtype = str(request?.subtype);
      if (id && request && subtype) m.outgoing = { ...m.outgoing, [id]: { subtype, request } };
      if (subtype === "interrupt" && id && m.running) {
        m.interrupting = true;
        m.interruptRequestId = id;
      }
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
      if (!message.parent_tool_use_id) noteTurnActivity(draft.next, at);
      return;
    case "assistant":
      applyAssistant(draft, message, seq, at);
      if (!message.parent_tool_use_id) noteTurnActivity(draft.next, at);
      return;
    case "user":
      applyUserOut(draft, message, seq, at, live);
      if (!message.parent_tool_use_id) noteTurnActivity(draft.next, at);
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
      const uuid = str(message.command_uuid);
      if (!uuid) return;
      if (message.state === "started") {
        startSent(draft, uuid, seq, at);
        return;
      }
      // A waiting message taken back before the CLI read it.
      if (message.state !== "cancelled") return;
      const index = draft.next.items.findIndex((item) => isWaiting(item) && item.sentUuid === uuid);
      if (index >= 0) draft.removeItem(index);
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

/**
 * The CLI begins a message the app wrote, which it can no longer take back
 * (cancel_async_message answers false from here). A message read during a
 * turn is echoed first, and taken by then. A command written during a turn
 * (/compact, /clear, a skill's) waits for the turn's end, then begins one of
 * its own, which its result ends: Claude Code 2.1.325 says it started right
 * after the turn's result, and echoes it only once it is done, after a
 * compaction's "compacting" status and its boundary. One sent with
 * priority "now" stops the turn and begins the same way.
 */
function startSent(draft: Draft, uuid: string, seq: number, at: number | undefined): void {
  const m = draft.next;
  const index = m.items.findIndex(
    (item) => item.kind === "user" && item.state === "sent" && item.sentUuid === uuid,
  );
  if (index < 0) return;
  const item = m.items[index] as UserItem;
  if (item.queued) {
    // It no longer waits above the box: it is read here, after what the turn did.
    const { queued: _queued, ...read } = item;
    draft.removeItem(index);
    draft.push({ ...read, at: at ?? item.at });
  }
  if (!m.running && m.process === "running") {
    m.running = true;
    m.turn = { id: `claude-${seq}`, startedAt: at, outputTokens: 0, thinkingTokens: 0 };
    noteTurnActivity(m, at);
  }
}

function applySystem(draft: Draft, message: Rec, seq: number, at: number | undefined): void {
  const m = draft.next;
  switch (message.subtype) {
    case "init": {
      m.sessionId = str(message.session_id) ?? m.sessionId;
      m.model = str(message.model) ?? m.model;
      if (typeof message.permissionMode === "string") {
        m.permissionMode = m.confirmedPermissionMode = message.permissionMode;
      }
      m.cwd = str(message.cwd) ?? m.cwd;
      m.version = str(message.claude_code_version) ?? m.version;
      if (Array.isArray(message.slash_commands)) {
        m.slashCommands = message.slash_commands.flatMap((raw) => {
          const name = str(raw);
          return name ? [{ name }] : [];
        });
      }
      return;
    }
    case "status": {
      const mode = str(message.permissionMode);
      if (mode) m.permissionMode = m.confirmedPermissionMode = mode;
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
        const status = num(message.error_status);
        m.turn = {
          ...m.turn,
          retry: {
            attempt: num(message.attempt) ?? 1,
            maxRetries: num(message.max_retries),
            delayMs: num(message.retry_delay_ms),
            ...(at === undefined ? {} : { at }),
            ...(status === undefined ? {} : { status }),
            reason: retryReasonOf(status, str(message.error)),
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
      takeContextTokens(m, rec(event.message)?.usage);
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

  // An API error Claude Code wrote in the turn's place: an error notice, not
  // Claude's words; the result after it says the same and adds none.
  if (!parent && isApiErrorMessage(message)) {
    const detail = userContent(content).text.trim();
    takeLimitParams(m, message);
    pushErrorNotice(draft, detail || str(message.error) || "API error", `n${seq}`, when);
    return;
  }

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

  takeContextTokens(m, body?.usage);
  // The block streamed so far has arrived whole.
  if (m.streaming && m.streaming.messageId === messageId)
    m.streaming = { ...m.streaming, blocks: {} };
  if (blocks.length === 0) return;

  // Claude can start answering a task notification without echoing a prompt.
  if (draft.matchSentInputs && m.process === "running" && !m.turn) {
    m.running = true;
    m.turn = { id: `claude-${seq}`, startedAt: when, outputTokens: 0, thinkingTokens: 0 };
  }
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
    ...(m.turn?.id ? { turnId: m.turn.id } : {}),
    uuid: str(message.uuid),
    blocks,
    at: when,
  });
}

/**
 * The context's size an API call's `usage` tells: the input it sent, cached
 * or not, which is the total get_context_usage counts after it. None for a
 * message with no usage, or one the CLI made up (all zero).
 */
function contextTokensOf(usage: unknown): number | undefined {
  const u = rec(usage);
  if (!u) return undefined;
  const tokens =
    (num(u.input_tokens) ?? 0) +
    (num(u.cache_creation_input_tokens) ?? 0) +
    (num(u.cache_read_input_tokens) ?? 0);
  return tokens > 0 ? tokens : undefined;
}

/**
 * get_context_usage's answer with the context's size at `tokens`: its
 * percentage too, and the free space less by as much as the total grew.
 * The other categories stay as counted.
 */
export function withContextTokens(usage: unknown, tokens: number): unknown {
  const body = rec(usage);
  if (!body || typeof body.totalTokens !== "number" || body.totalTokens === tokens) return usage;
  const grew = tokens - body.totalTokens;
  const max = num(body.maxTokens) ?? 0;
  return {
    ...body,
    totalTokens: tokens,
    ...(max > 0 ? { percentage: Math.round((tokens / max) * 100) } : {}),
    ...(Array.isArray(body.categories)
      ? {
          categories: body.categories.map((raw) => {
            const category = rec(raw);
            const free = category?.kind === "free" ? num(category.tokens) : undefined;
            return free === undefined ? raw : { ...category, tokens: Math.max(0, free - grew) };
          }),
        }
      : {}),
  };
}

/**
 * The context's size a line from the CLI says the main thread's API call
 * sent: a message's start as it streams, or the message whole. None for a
 * subagent's, a teammate's or a fork's, nor for any other line.
 */
export function mainCallContextTokens(message: unknown): number | undefined {
  const line = rec(message);
  if (!line || line.parent_tool_use_id) return undefined;
  if (line.type === "assistant") return contextTokensOf(rec(line.message)?.usage);
  if (line.type !== "stream_event") return undefined;
  const event = rec(line.event);
  return event?.type === "message_start" ? contextTokensOf(rec(event.message)?.usage) : undefined;
}

/**
 * Moves the context's size on as the main thread's API call says it, so it
 * follows a turn of many calls, which get_context_usage is asked only at
 * the end of; asked more often, it would count each category with the
 * token-count API. With no count to move yet, the controller asks for one
 * once (askContextBase).
 */
function takeContextTokens(m: ChatModel, usage: unknown): void {
  const tokens = contextTokensOf(usage);
  if (tokens !== undefined && m.contextUsage !== undefined) {
    m.contextUsage = withContextTokens(m.contextUsage, tokens);
  }
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
    let index =
      draft.matchSentInputs && uuid
        ? m.items.findIndex((item) => sent(item) && (item as UserItem).sentUuid === uuid)
        : -1;
    // One the app did not write may be no message of the user's at all: a
    // shell command run in the terminal, which no turn follows.
    if (index < 0 && applyShell(draft, said, seq, when)) return;
    const other = index < 0 ? notTheUsers(message, said) : null;
    if (draft.matchSentInputs && !other && index < 0) index = m.items.findIndex(sent);
    // Taken live after a turn ended, it begins the next one: one the user
    // sent as the last turn was ending, or one the CLI was given itself
    // (Remote Control, a background task's news). A transcript's messages
    // come the same way, with no turn's end after them.
    if ((live || index >= 0) && !m.running && m.process === "running") {
      m.running = true;
      m.turn = { id: `claude-${seq}`, startedAt: when, outputTokens: 0, thinkingTokens: 0 };
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
      const taken: UserItem = {
        ...item,
        state: "taken",
        uuid,
        at: item.at ?? when,
        ...(m.turn?.id ? { turnId: m.turn.id } : {}),
      };
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
        ...(m.turn?.id ? { turnId: m.turn.id } : {}),
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
  const { subtype, isError, terminalReason, outcome, detail } = claudeTurnResult(message);
  const turnId = m.turn?.id;
  m.running = false;
  m.turn = null;
  m.streaming = null;
  clearInterrupt(m);
  const backgroundCalls = new Set(
    Object.values(m.tasks)
      .filter(
        (task) => task.status === "running" && (task.backgrounded || task.type === "local_bash"),
      )
      .map((task) => task.toolUseId),
  );
  const background = (id: string | undefined) => {
    const tool = id ? m.tools[id] : undefined;
    return (
      id !== undefined && (backgroundCalls.has(id) || rec(tool?.input)?.run_in_background === true)
    );
  };
  m.permissions = m.permissions.filter(
    (request) => request.agentId || background(request.toolUseId),
  );
  stopRunningTools(draft, (tool) => tool.parentToolUseId === null && !background(tool.id));
  const cost = num(message.total_cost_usd);
  if (cost !== undefined) {
    m.costUsd = (m.costUsd ?? 0) - (m.processCostUsd ?? 0) + cost;
    m.processCostUsd = cost;
  }
  const failure = outcome === "error" ? claudeTurnFailure(message) : undefined;
  m.lastResult = {
    subtype,
    isError,
    ...(turnId ? { turnId } : {}),
    durationMs: num(message.duration_ms),
    numTurns: num(message.num_turns),
    costUsd: num(message.total_cost_usd),
    terminalReason,
    outcome,
    at,
    ...(outcome === "error" ? { error: detail } : {}),
    ...(failure ? { failure } : {}),
  };
  if (outcome === "error") pushErrorNotice(draft, detail, `n${seq}`, at);
  finishSubmittedTurn(draft, turnId, outcome === "error" ? detail : undefined);
}

/** Claude Code's message for an API error that ended the turn (`is_api_error_message`). */
function isApiErrorMessage(message: Rec): boolean {
  return (
    message.is_api_error_message === true ||
    (str(message.error) !== undefined && str(rec(message.message)?.model) === "<synthetic>")
  );
}

/**
 * The plan's limit an API error tells (`api_error_params.rate_limit_info`),
 * as a rate_limit_event would: a transcript read again has no such event.
 */
function takeLimitParams(m: ChatModel, message: Rec): void {
  const info = rec(rec(message.api_error_params)?.rate_limit_info);
  const status = str(info?.status);
  if (!info || !status) return;
  m.rateLimit = {
    status,
    resetsAt: num(info.resetsAt),
    rateLimitType: str(info.rateLimitType),
  };
}

/** An error notice, once: the API error and the result after it tell the same. */
function pushErrorNotice(
  draft: Draft,
  detail: string | undefined,
  key: string,
  at: number | undefined,
): void {
  const last = draft.next.items.at(-1);
  if (last?.kind === "notice" && last.code === "error" && last.detail === detail) return;
  draft.push({ kind: "notice", key, code: "error", detail, at });
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
    if (subtype === "interrupt") clearInterrupt(m, id);
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
      if (typeof body.current_permission_mode === "string") {
        m.permissionMode = m.confirmedPermissionMode = body.current_permission_mode;
      }
      m.version = str(body.claude_code_version) ?? m.version;
      return;
    }
    case "set_permission_mode": {
      // The first switch of a process sends no system/status: the answer says.
      const mode = str(body.mode) ?? str(request.mode);
      if (mode) m.permissionMode = m.confirmedPermissionMode = mode;
      return;
    }
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
      // the headers' windows or no limits at all: then the last answer that
      // had them stays.
      if (!m.usage || usageLimitsOf(body).length > 0) m.usage = body;
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
