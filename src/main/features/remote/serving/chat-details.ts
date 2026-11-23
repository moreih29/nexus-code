import {
  type ChatPage,
  type ChatRun,
  fitPeek,
  MAX_AGENT_DESCRIPTION,
  MAX_CHAT_RUNS,
  MAX_RUN_TEXT,
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
  type ViewToolCall,
} from "../../../../../packages/remote-protocol/src";
import type { AgentRun } from "../../../../shared/claude/activity";
import type { CliServices } from "../../cli/context";
import { MAX_MESSAGE_BYTES, RpcFailure } from "../room";
import { chatFailure } from "./chat";
import { fitsAsResult, oneLine, tabOf, unavailable, workspaceOf } from "./common";
import { ReadBudget } from "./read-budget";

/** How many items a chat read gives when it does not say (the renderer's default too). */
export const DEFAULT_READ_ITEMS = 200;

/**
 * A page of the chat, of up to `limit` items: fewer when that many would
 * not go in one frame (long tool results, a long reply), down to one item.
 */
export async function readChat(
  services: CliServices,
  { workspaceId, tabId, before, limit }: RpcParams<"chat.read">,
  from?: string,
): Promise<RpcResult<"chat.read">> {
  const budget = new ReadBudget(services, "chat.read", from, 12_000);
  try {
    await tabOf(services, workspaceId, tabId, ["claude", "codex"], budget);
    let count = limit ?? DEFAULT_READ_ITEMS;
    for (;;) {
      const page = await budget
        .ui(
          "chat.page",
          { workspaceId, tabId, ...(before !== undefined ? { before } : {}), limit: count },
          budget.remaining(),
        )
        .catch(unavailable);
      if (fitsAsResult(page)) return page;
      const fittedChildren = fitOversizeCodexChildren(page);
      if (fittedChildren) return fittedChildren;
      if (page.items.length <= 1) {
        const fitted = fitPage(page);
        if (fitted) return fitted;
        throw new RpcFailure(
          RpcErrorCode.Unavailable,
          "that part of the chat is too large to send",
        );
      }
      count = Math.max(1, Math.floor(page.items.length / 2));
    }
  } finally {
    budget.report();
  }
}

/**
 * The chat's last turns at a glance (chat.peek), as the app reads them
 * without opening the tab: from the conversation an open tab holds, else
 * from the end of its history. Fitted in MAX_PEEK_BYTES here too, whatever
 * the window answered.
 */
export async function peekChat(
  services: CliServices,
  { workspaceId, tabId, turns }: RpcParams<"chat.peek">,
  from?: string,
): Promise<RpcResult<"chat.peek">> {
  const budget = new ReadBudget(services, "chat.peek", from, 8_000);
  try {
    await tabOf(services, workspaceId, tabId, ["claude", "codex"], budget);
    const peek = await budget
      .ui(
        "chat.peek",
        { workspaceId, tabId, ...(turns !== undefined ? { turns } : {}) },
        budget.remaining(),
      )
      .catch(unavailable);
    return fitPeek(peek);
  } finally {
    budget.report();
  }
}

/**
 * Native Codex children appear on the latest page regardless of its parent
 * item count. If their messages alone exceed the frame, the existing
 * subagent fallback can keep the parent page before it is narrowed.
 */
export function fitOversizeCodexChildren<P extends ChatPage>(page: P): P | null {
  if (
    page.status?.agent !== "codex" ||
    page.start + page.items.length !== page.total ||
    fitsAsResult({ agentItems: page.agentItems })
  ) {
    return null;
  }
  const parent = withoutSubagentItems(page);
  return fitsAsResult(parent) ? parent : null;
}

function withoutSubagentItems<P extends ChatPage>(page: P): P {
  const tools = Object.fromEntries(
    Object.entries(page.tools).filter(([, tool]) => tool.parentToolUseId === null),
  );
  return { ...page, tools, agentItems: {} };
}

/** The most of each tool's result a page keeps, in turn, when one item is too large to send. */
const FITTED_RESULT_CHARS = [8 * 1024, 1024, 0];

/**
 * A page of one item too large for a frame as it is (a reply whose calls gave long results, a
 * subagent's whole run), made to go in one: its tools' results cut shorter, each marked
 * `truncated` (the other device reads a call whole by chat.tool), and at last its subagents'
 * messages and calls left out. Refused, the item would stop the chat being read further back
 * there at all. Null when even that is too large.
 */
export function fitPage<P extends ChatPage>(page: P): P | null {
  for (const most of FITTED_RESULT_CHARS) {
    const cut = { ...page, tools: cutResults(page.tools, most) };
    if (fitsAsResult(cut)) return cut;
  }
  const parent = withoutSubagentItems(page);
  const bare = { ...parent, tools: cutResults(parent.tools, 0) };
  return fitsAsResult(bare) ? bare : null;
}

/** Tools with at most `most` characters of each result, and no structured result where cut. */
function cutResults(
  tools: Record<string, ViewToolCall>,
  most: number,
): Record<string, ViewToolCall> {
  const cut: Record<string, ViewToolCall> = {};
  for (const [id, tool] of Object.entries(tools)) {
    const result = tool.result;
    if (!result || (result.text.length <= most && result.structured === undefined)) {
      cut[id] = tool;
      continue;
    }
    const { structured: _left, ...rest } = result;
    let text = result.text.slice(0, most);
    // A character of two halves is not split.
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    cut[id] = { ...tool, result: { ...rest, text, truncated: true } };
  }
  return cut;
}

/**
 * The sessions' state changes, as `nexus events` lists them: after `since`
 * (the first ones, `more` when some were left out), or the last ones. As
 * many as go in a frame, each message in a line.
 */
export async function readEvents(
  services: CliServices,
  { since, limit }: RpcParams<"events.read">,
): Promise<RpcResult<"events.read">> {
  const read = await services
    .ui("events.read", {
      ...(since !== undefined ? { since } : {}),
      limit: limit ?? DEFAULT_EVENTS,
    })
    .catch(unavailable);
  let events: RpcResult<"events.read">["events"] = read.events.map((e) => ({
    seq: e.seq,
    at: e.at,
    workspaceId: e.workspaceId,
    tabId: e.tabId,
    title: e.title,
    kind: e.kind,
    ...(e.agent ? { agent: e.agent } : {}),
    from: e.from,
    to: e.to,
    ...(e.message ? { message: oneLine(e.message, 500) } : {}),
  }));
  let more = read.more;
  while (events.length > 0 && !fitsAsResult({ events, cursor: read.cursor, more })) {
    const half = Math.ceil(events.length / 2);
    if (since === undefined) {
      // The last ones: the latest are kept.
      events = events.slice(half);
    } else {
      // After `since`: the first are kept, and the rest left for the next read.
      events = events.slice(0, events.length - half);
      more = true;
    }
  }
  return { events, cursor: read.cursor, more };
}

/** Most characters of a tool's result asked for: more than a frame takes anyway. */
const MAX_TOOL_TEXT = MAX_MESSAGE_BYTES;

/** One tool call, a subagent's too, with as much of its result as a frame takes. */
export async function chatTool(
  services: CliServices,
  { workspaceId, tabId, toolUseId, cli }: RpcParams<"chat.tool">,
): Promise<RpcResult<"chat.tool">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  if (cli) {
    const found = await services
      .ui("chat.tool", { workspaceId, tabId, ref: toolUseId })
      .catch(unavailable);
    const result = found.result
      ? { ...found.result, text: found.result.text.slice(0, MAX_TOOL_TEXT / 4), images: [] }
      : undefined;
    const tool = {
      id: found.toolUseId,
      index: found.i,
      name: found.name,
      status: found.status,
      input: found.input,
      parentToolUseId: found.parentToolUseId ?? null,
      ...(result
        ? {
            result: {
              ...result,
              ...(result.text.length < (found.result?.text.length ?? 0) ? { truncated: true } : {}),
            },
          }
        : {}),
    };
    if (!fitsAsResult(tool))
      throw new RpcFailure(RpcErrorCode.Unavailable, "that call is too large to send");
    return tool;
  }
  const ask = (maxText: number) =>
    services
      .ui("chat.toolCall", { workspaceId, tabId, toolUseId, maxText })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (/^no tool call /.test(message)) throw new RpcFailure(RpcErrorCode.NotFound, message);
        return unavailable(error);
      });
  let tool = await ask(MAX_TOOL_TEXT);
  // Its input, or text that escapes long in JSON: asked again with less of the result.
  for (let maxText = MAX_TOOL_TEXT / 2; !fitsAsResult(tool); maxText = Math.floor(maxText / 2)) {
    if (maxText < 1024)
      throw new RpcFailure(RpcErrorCode.Unavailable, "that call is too large to send");
    tool = await ask(maxText);
  }
  return tool;
}

/** A file the chat changed as it was before, for its diff, where it is kept and goes in a frame. */
export async function chatOriginal(
  services: CliServices,
  { workspaceId, tabId, path }: RpcParams<"chat.original">,
): Promise<RpcResult<"chat.original">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  const { found, before } = await services
    .ui("chat.original", { workspaceId, tabId, path })
    .catch(unavailable);
  if (!found) throw new RpcFailure(RpcErrorCode.NotFound, `no original kept of ${path}`);
  const result = { before };
  if (!fitsAsResult(result)) {
    throw new RpcFailure(RpcErrorCode.Unavailable, "that file is too large to send");
  }
  return result;
}

/** What the chat's side panel shows; its changed files cut to what goes in a frame. */
export async function chatPanel(
  services: CliServices,
  { workspaceId, tabId, from }: RpcParams<"chat.panel">,
): Promise<RpcResult<"chat.panel">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  const panel = await services.ui("chat.panel", { workspaceId, tabId }).catch(unavailable);
  const session = panel.session;
  if (from && session) {
    const { account: _account, ...safe } = session;
    return fitPanel({ ...panel, session: safe });
  }
  return fitPanel(panel);
}
function fitPanel(panel: RpcResult<"chat.panel">): RpcResult<"chat.panel"> {
  let { changedFiles } = panel;
  while (changedFiles.length > 0 && !fitsAsResult({ ...panel, changedFiles })) {
    changedFiles = changedFiles.slice(0, Math.floor(changedFiles.length / 2));
  }
  return { ...panel, changedFiles };
}

/** Text cut to `max` characters, an ellipsis where it was cut. */
function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** What a run's row and its pane both tell of it. */
function runFactsOf(run: AgentRun): ChatRun {
  return {
    id: run.id,
    ...(run.program ? { program: run.program } : {}),
    ...(run.endpoint ? { endpoint: cut(run.endpoint, 200) } : {}),
    ...(run.model ? { model: cut(run.model, 200) } : {}),
    ...(run.description ? { description: oneLine(run.description, MAX_AGENT_DESCRIPTION) } : {}),
    start: run.start,
    ...(run.end !== undefined ? { end: run.end } : {}),
    state: run.state,
    toolCount: Math.max(0, run.toolCount),
    failedCount: Math.max(0, run.failedCount),
    ...(run.toolsTold ? { toolsTold: true } : {}),
    ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
    ...(run.sessionId ? { sessionId: cut(run.sessionId, 200) } : {}),
  };
}

/** How long a run row's prompt, tool and last words are. */
const RUN_ROW_TEXT = 300;

/**
 * A `claude -p` or `codex exec` run as the chat's agents list it: what it
 * is, how it stands, the tool it runs now and what it wrote last.
 */
export function runRowOf(run: AgentRun): ChatRun {
  const tool = [...run.tools].reverse().find((t) => t.end === undefined && !t.background);
  const last = run.answer ?? run.messages?.at(-1)?.text;
  return {
    ...runFactsOf(run),
    ...(run.prompt ? { prompt: cut(run.prompt, RUN_ROW_TEXT) } : {}),
    ...(tool ? { current: cut(tool.target ? `${tool.name} ${tool.target}` : tool.name, 200) } : {}),
    ...(last ? { last: cut(last, RUN_ROW_TEXT) } : {}),
  };
}

/** A run as its pane shows it: its tools, messages and answer too, fewer messages where they would not fit. */
export function runDetailOf(run: AgentRun): ChatRun {
  const detail = (messages: NonNullable<AgentRun["messages"]> | undefined): ChatRun => ({
    ...runFactsOf(run),
    ...(run.prompt ? { prompt: cut(run.prompt, MAX_RUN_TEXT) } : {}),
    tools: run.tools.slice(-30).map((tool) => ({
      id: cut(tool.id, 200),
      name: cut(tool.name, 200),
      ...(tool.target ? { target: cut(tool.target, 2000) } : {}),
      ...(tool.note ? { note: cut(tool.note, 2000) } : {}),
      start: tool.start,
      ...(tool.end !== undefined ? { end: tool.end } : {}),
      ...(tool.failed ? { failed: true } : {}),
      ...(tool.error ? { error: cut(tool.error, 2000) } : {}),
      ...(tool.background ? { background: true } : {}),
      ...(tool.denied ? { denied: true } : {}),
    })),
    ...(messages
      ? { messages: messages.map((m) => ({ at: m.at, text: cut(m.text, MAX_RUN_TEXT) })) }
      : {}),
    ...(run.answer ? { answer: cut(run.answer, MAX_RUN_TEXT) } : {}),
  });
  let messages = run.messages?.slice(-20);
  let shown = detail(messages);
  while (messages && messages.length > 0 && !fitsAsResult({ run: shown })) {
    messages = messages.slice(Math.ceil(messages.length / 2));
    shown = detail(messages);
  }
  return shown;
}

/** The `claude -p` and `codex exec` runs of the chat's session, as its agents list them. */
export async function chatRuns(
  services: CliServices,
  { workspaceId, tabId }: RpcParams<"chat.runs">,
): Promise<RpcResult<"chat.runs">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  const runs = services.claudeAgents
    .list(workspaceId, tabId)
    .filter((agent) => agent.kind === "print")
    .slice(0, MAX_CHAT_RUNS);
  return { runs: runs.map(runRowOf) };
}

/** One of the chat's runs, as its pane shows it. */
export async function chatRun(
  services: CliServices,
  { workspaceId, tabId, runId }: RpcParams<"chat.run">,
): Promise<RpcResult<"chat.run">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  const run = services.claudeAgents
    .list(workspaceId, tabId)
    .find((agent) => agent.kind === "print" && agent.id === runId);
  if (!run) throw new RpcFailure(RpcErrorCode.NotFound, `no run ${runId}: it is not kept`);
  return { run: runDetailOf(run) };
}

/**
 * A page of one of the chat's runs, read from the run's own session: as
 * readChat gives one of the chat, with the same checks of who asks and the
 * same fitting in a frame. The run is found among that chat's only, as the
 * app recorded them; where its session is kept is main's to know.
 */
export async function readChatRun(
  services: CliServices,
  { workspaceId, tabId, runId, before, limit }: RpcParams<"chat.runRead">,
  from?: string,
): Promise<RpcResult<"chat.runRead">> {
  const budget = new ReadBudget(services, "chat.runRead", from, 12_000);
  try {
    await tabOf(services, workspaceId, tabId, ["claude", "codex"], budget);
    const run = services.claudeAgents
      .list(workspaceId, tabId)
      .find((agent) => agent.kind === "print" && agent.id === runId);
    if (!run) throw new RpcFailure(RpcErrorCode.NotFound, `no run ${runId}: it is not kept`);
    let count = limit ?? DEFAULT_READ_ITEMS;
    for (;;) {
      const page = await budget
        .ui(
          "chat.runPage",
          { workspaceId, tabId, runId, ...(before !== undefined ? { before } : {}), limit: count },
          budget.remaining(),
        )
        .catch(unavailable);
      if (!page) {
        throw new RpcFailure(RpcErrorCode.NotFound, `run ${runId} keeps no session to read`);
      }
      if (fitsAsResult(page)) return page;
      if (page.items.length <= 1) {
        const fitted = fitPage(page);
        if (fitted) return fitted;
        throw new RpcFailure(RpcErrorCode.Unavailable, "that part of the run is too large to send");
      }
      count = Math.max(1, Math.floor(page.items.length / 2));
    }
  } finally {
    budget.report();
  }
}

/** Whether rewinding to before a user message can restore files. */
export async function previewChatRewind(
  services: CliServices,
  { workspaceId, tabId, itemKey }: RpcParams<"chat.rewindPreview">,
): Promise<RpcResult<"chat.rewindPreview">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  const preview = await services
    .ui("chat.rewindPreview", { workspaceId, tabId, itemKey })
    .catch(chatFailure);
  // A rewind that touches many files names as many as go in a frame.
  let { filesChanged } = preview;
  while (filesChanged.length > 0 && !fitsAsResult({ ...preview, filesChanged })) {
    filesChanged = filesChanged.slice(0, Math.floor(filesChanged.length / 2));
  }
  return { ...preview, filesChanged };
}

/** The workspace's conversations of the past that a new chat can go on with. */
export async function listHistory(
  services: CliServices,
  { workspaceId, agent, query, limit }: RpcParams<"history.list">,
): Promise<RpcResult<"history.list">> {
  if (!workspaceOf(services, workspaceId)) {
    throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
  }
  const { sessions } = await services
    .ui("chat.history", {
      workspaceId,
      agent,
      ...(agent === "codex" ? { peer: true } : {}),
      ...(query ? { query } : {}),
      ...(limit ? { limit } : {}),
    })
    .catch(unavailable);
  // Long first prompts for titles: as many as go in a frame.
  let shown = sessions;
  while (shown.length > 0 && !fitsAsResult({ sessions: shown })) {
    shown = shown.slice(0, Math.floor(shown.length / 2));
  }
  return { sessions: shown };
}

/** How many session changes an events.read with no `limit` reads. */
export const DEFAULT_EVENTS = 100;
