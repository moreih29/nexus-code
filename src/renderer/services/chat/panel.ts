// What a Claude tab's side panel and agent strip show, read from its model:
// the agents and tasks the CLI reports, the to-do list Claude keeps, the
// files it changed, and what its replies point at.

import type { AgentRun } from "../../../shared/claude/activity";
import { isUnder, resolveFilePath, resultFiles, slashWindowsPath } from "./links";
import type {
  AssistantItem,
  ChatItem,
  ChatModel,
  ImageBlock,
  TaskInfo,
  ToolCall,
  UserItem,
} from "./model";

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The tools that start a subagent. */
export const AGENT_TOOLS = new Set(["Agent", "Task"]);

/** Task types that are agents, shown in the strip and 에이전트, not 작업. */
const AGENT_TASK_TYPES = new Set(["local_agent", "remote_agent", "in_process_teammate"]);

export type AgentStatus = "running" | "completed" | "failed" | "stopped";

export interface AgentRow {
  /** The Agent call it runs under, which its messages and tools point at. */
  toolUseId: string;
  taskId?: string;
  description: string;
  subagentType?: string;
  model?: string;
  status: AgentStatus;
  startedAt?: number;
  endedAt?: number;
  toolCount: number;
  /** The tool it runs now, as "Bash ls". */
  currentTool?: string;
  /** The end of what it last wrote. */
  lastText?: string;
  prompt?: string;
  teammate: boolean;
  /** A `claude -p` run the session started, which has no Agent call (chat/print-runs.ts). */
  run?: AgentRun;
}

function agentStatus(task: TaskInfo | undefined, tool: ToolCall | undefined): AgentStatus {
  const status = task?.status ?? tool?.status;
  switch (status) {
    case "running":
    case "streaming":
      return "running";
    case "completed":
    case "done":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    default:
      return "stopped";
  }
}

/** The subagents and teammates of the session, in the order they started. */
export function agentsOf(model: ChatModel): AgentRow[] {
  const tasksByTool = new Map<string, TaskInfo>();
  for (const task of Object.values(model.tasks)) {
    if (task.toolUseId) tasksByTool.set(task.toolUseId, task);
  }
  const children = new Map<string, ToolCall[]>();
  for (const tool of Object.values(model.tools)) {
    if (!tool.parentToolUseId) continue;
    const list = children.get(tool.parentToolUseId) ?? [];
    list.push(tool);
    children.set(tool.parentToolUseId, list);
  }
  const rows: AgentRow[] = [];
  const seen = new Set<string>();
  const row = (toolUseId: string, tool: ToolCall | undefined, task: TaskInfo | undefined) => {
    seen.add(toolUseId);
    const input = rec(tool?.input) ?? {};
    const structured = rec(tool?.result?.structured);
    const own = children.get(toolUseId) ?? [];
    const running = [...own].reverse().find((t) => t.status === "running");
    const lastText = lastTextOf(model.agentItems[toolUseId]);
    rows.push({
      toolUseId,
      taskId: task?.taskId,
      description: task?.description || str(input.description) || tool?.name || "",
      subagentType: task?.subagentType ?? str(input.subagent_type),
      model: str(structured?.resolvedModel) ?? str(input.model),
      status: agentStatus(task, tool),
      startedAt: task?.startedAt,
      endedAt: task?.endedAt,
      toolCount: Math.max(own.length, task?.toolUses ?? 0),
      currentTool: running ? toolLabel(running) : (task?.activity ?? task?.lastToolName),
      lastText,
      prompt: task?.prompt ?? str(input.prompt),
      teammate: task?.type === "in_process_teammate",
    });
  };
  for (const tool of Object.values(model.tools)) {
    if (tool.parentToolUseId || !AGENT_TOOLS.has(tool.name)) continue;
    row(tool.id, tool, tasksByTool.get(tool.id));
  }
  // Teammates and agents the CLI reports with no Agent call in sight.
  for (const task of Object.values(model.tasks)) {
    if (!AGENT_TASK_TYPES.has(task.type)) continue;
    const id = task.toolUseId ?? task.taskId;
    if (!seen.has(id)) row(id, undefined, task);
  }
  return rows;
}

function toolLabel(tool: ToolCall): string {
  const input = rec(tool.input) ?? {};
  const detail =
    str(input.command) ?? str(input.file_path) ?? str(input.pattern) ?? str(input.description);
  return detail ? `${tool.name} ${detail.split("\n")[0]}` : tool.name;
}

function lastTextOf(items: AssistantItem[] | undefined): string | undefined {
  if (!items) return undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const blocks = items[i].blocks;
    for (let j = blocks.length - 1; j >= 0; j--) {
      const block = blocks[j];
      if (block.type === "text" && block.text.trim()) return block.text.trim();
    }
  }
  return undefined;
}

/** What an agent's pane shows: the prompt it got, then its messages. */
export function agentTranscript(model: ChatModel, agent: AgentRow): ChatItem[] {
  const prompt: UserItem[] = agent.prompt
    ? [
        {
          kind: "user",
          key: `prompt-${agent.toolUseId}`,
          text: agent.prompt,
          images: [],
          state: "taken",
          at: agent.startedAt,
        },
      ]
    : [];
  return [...prompt, ...(model.agentItems[agent.toolUseId] ?? [])];
}

/** Background Bash runs, workflows and the like: the tasks that are not agents. */
export function jobsOf(model: ChatModel): TaskInfo[] {
  return Object.values(model.tasks).filter((task) => !AGENT_TASK_TYPES.has(task.type));
}

export interface TodoItem {
  id: string;
  content: string;
  /** pending, in_progress or completed. */
  status: string;
}

/**
 * The to-do list Claude keeps: TodoWrite's latest list, or the items
 * TaskCreate added and TaskUpdate changed (2.1.318 has those instead).
 */
export function todosOf(tools: Record<string, ToolCall>): TodoItem[] {
  let todos: TodoItem[] = [];
  for (const tool of Object.values(tools)) {
    if (tool.parentToolUseId || tool.status === "denied") continue;
    const input = rec(tool.input) ?? {};
    if (tool.name === "TodoWrite" && Array.isArray(input.todos)) {
      todos = input.todos.flatMap((raw, i) => {
        const todo = rec(raw);
        const content = str(todo?.content);
        return todo && content
          ? [{ id: str(todo.id) ?? String(i + 1), content, status: str(todo.status) ?? "pending" }]
          : [];
      });
    } else if (tool.name === "TaskCreate" && tool.status === "done") {
      const created = rec(rec(tool.result?.structured)?.task);
      const id = str(created?.id);
      const content = str(created?.subject) ?? str(input.subject);
      if (id && content) todos = [...todos, { id, content, status: "pending" }];
    } else if (tool.name === "TaskUpdate" && tool.status === "done") {
      const id = str(input.taskId);
      const status = str(input.status);
      const subject = str(input.subject);
      if (status === "deleted") todos = todos.filter((t) => t.id !== id);
      else {
        todos = todos.map((t) =>
          t.id === id ? { ...t, status: status ?? t.status, content: subject ?? t.content } : t,
        );
      }
    }
  }
  return todos;
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
  /** Written new by the session. */
  created: boolean;
  /**
   * The file before the session first changed it: null when the session
   * wrote it new, absent when the change did not say (a notebook's).
   */
  before?: string | null;
  /** The calls that changed it, oldest first. */
  toolUseIds: string[];
}

/** The files the session's edits changed, in the order it first touched them. */
export function changedFilesOf(tools: Record<string, ToolCall>): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  for (const tool of Object.values(tools)) {
    if (!EDIT_TOOLS.has(tool.name) || tool.status !== "done") continue;
    const input = rec(tool.input) ?? {};
    const named = str(input.file_path) ?? str(input.notebook_path);
    if (!named) continue;
    // One file whichever way its edits wrote a Windows path.
    const path = slashWindowsPath(named);
    const structured = rec(tool.result?.structured);
    const file = files.get(path) ?? {
      path,
      added: 0,
      removed: 0,
      created: false,
      toolUseIds: [],
    };
    file.toolUseIds.push(tool.id);
    if (file.toolUseIds.length === 1) {
      const original = structured?.originalFile;
      if (structured?.type === "create") file.before = null;
      else if (typeof original === "string") file.before = original;
    }
    if (structured?.type === "create") {
      file.created = file.toolUseIds.length === 1 || file.created;
      file.added += lineCount(str(input.content) ?? "");
    } else {
      const { added, removed } = patchCounts(structured?.structuredPatch);
      file.added += added;
      file.removed += removed;
    }
    files.set(path, file);
  }
  return [...files.values()];
}

function lineCount(text: string): number {
  if (!text) return 0;
  const lines = text.split("\n");
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

function patchCounts(patch: unknown): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  if (!Array.isArray(patch)) return { added, removed };
  for (const raw of patch) {
    const lines = rec(raw)?.lines;
    if (!Array.isArray(lines)) continue;
    for (const line of lines) {
      if (typeof line !== "string") continue;
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}

export interface ResultEntry {
  kind: "file" | "url";
  /** An absolute path, a path as the reply wrote it, or a URL. */
  target: string;
  /** A file the session wrote new. */
  created: boolean;
}

const URL_RE = /\bhttps?:\/\/[^\s<>()[\]"'`]+[^\s<>()[\]"'`.,;:!?]/g;
const LINK_RE = /\]\(([^)\s]+)\)/g;
const CODE_RE = /`([^`\n]+)`/g;

/** A path a reply names: absolute, or relative with a folder or an extension. */
function looksLikePath(text: string): boolean {
  if (/\s/.test(text) || text.length > 300) return false;
  if (text.startsWith("/") || text.startsWith("~/")) return text.length > 1;
  if (/^[A-Za-z]:[\\/]/.test(text)) return text.length > 3;
  return /^[\w.-]+(\/[\w.-]+)*\.[A-Za-z0-9]{1,8}$/.test(text);
}

/**
 * What the session made and pointed at: the files it wrote new, then the
 * paths and URLs in its replies, each once, in the order they came.
 */
export function resultsOf(items: ChatItem[], tools: Record<string, ToolCall>): ResultEntry[] {
  const results: ResultEntry[] = [];
  const seen = new Set<string>();
  const add = (kind: ResultEntry["kind"], target: string, created = false) => {
    if (seen.has(target)) return;
    seen.add(target);
    results.push({ kind, target, created });
  };
  for (const tool of Object.values(tools)) {
    if (tool.name !== "Write" || tool.status !== "done") continue;
    const path = str(rec(tool.input)?.file_path);
    if (path && rec(tool.result?.structured)?.type === "create") add("file", path, true);
  }
  for (const item of items) {
    if (item.kind !== "assistant") continue;
    for (const block of item.blocks) {
      if (block.type !== "text") continue;
      for (const match of block.text.matchAll(LINK_RE)) {
        const target = match[1];
        if (/^https?:\/\//.test(target)) add("url", target);
        else if (looksLikePath(target)) add("file", target);
      }
      for (const match of block.text.matchAll(URL_RE)) add("url", match[0]);
      for (const match of block.text.matchAll(CODE_RE)) {
        if (looksLikePath(match[1])) add("file", match[1]);
      }
    }
  }
  return results;
}

/** What an answer ends with: the files its turn made and named, and the images its tools gave. */
export interface AnswerExtras {
  /** Absolute paths: written new first, then linked. */
  files: string[];
  images: ImageBlock[];
}

/** Most file cards under one answer. */
export const MAX_ANSWER_FILES = 8;
/** Most images under one answer. */
export const MAX_ANSWER_IMAGES = 4;

/**
 * For each finished turn, what its last answer ends with, by that answer's
 * item. The last turn counts once `lastDone`: while it runs, its answer is
 * not the last yet. An image a tool read from a file the answer names, in
 * the workspace (`root`), is left to that file's card.
 */
export function answerExtras(
  items: ChatItem[],
  tools: Record<string, ToolCall>,
  cwd: string,
  root: string,
  lastDone: boolean,
): Map<ChatItem, AnswerExtras> {
  const out = new Map<ChatItem, AnswerExtras>();
  let turn: ChatItem[] = [];
  const close = () => {
    const answer = [...turn].reverse().find((item) => item.kind === "assistant");
    if (!answer) return;
    const named: string[] = [];
    const given: { image: ImageBlock; from?: string }[] = [];
    for (const item of turn) {
      if (item.kind !== "assistant") continue;
      for (const block of item.blocks) {
        const tool = block.type === "tool" ? tools[block.toolUseId] : undefined;
        if (!tool) continue;
        const path = str(rec(tool.input)?.file_path);
        const from = path ? (resolveFilePath(path, cwd) ?? undefined) : undefined;
        for (const image of tool.result?.images ?? []) given.push({ image, from });
        if (tool.name === "Write" && tool.status === "done" && path) {
          if (rec(tool.result?.structured)?.type === "create") named.push(path);
        }
      }
    }
    for (const result of resultsOf(turn, {})) {
      if (result.kind === "file") named.push(result.target);
    }
    const files: string[] = [];
    for (const target of named) {
      const path = resolveFilePath(target, cwd);
      if (path && !files.includes(path)) files.push(path);
    }
    const images = given
      .filter(({ from }) => !(from && files.includes(from) && isUnder(from, root)))
      .map(({ image }) => image);
    if (files.length > 0 || images.length > 0) {
      out.set(answer, {
        files: files.slice(0, MAX_ANSWER_FILES),
        images: images.slice(0, MAX_ANSWER_IMAGES),
      });
    }
  };
  for (const item of items) {
    if (item.kind === "user") {
      close();
      turn = [];
    } else turn.push(item);
  }
  if (lastDone) close();
  return out;
}

/** What a Claude tab lets the previews read outside the workspace. */
export interface OutsideLinks {
  files: string[];
  /** The folders of its HTML files, whose pages load their siblings. */
  dirs: string[];
}

/** Most files and folders one tab grants; the newest are kept. */
export const MAX_OUTSIDE_FILES = 2000;
export const MAX_OUTSIDE_DIRS = 200;

/**
 * The files outside the workspace (`root`) that a session names: the ones
 * its tools took, its replies point at, and `looked` (opened from the tab
 * otherwise). An HTML file's folder comes too, unless it holds the
 * workspace, as the home folder does.
 */
export function outsideLinksOf(
  items: ChatItem[],
  tools: Record<string, ToolCall>,
  cwd: string,
  root: string,
  looked: readonly string[] = [],
): OutsideLinks {
  if (!root) return { files: [], dirs: [] };
  const named = new Set<string>(looked);
  for (const tool of Object.values(tools)) {
    const input = rec(tool.input);
    const path = str(input?.file_path) ?? str(input?.notebook_path);
    const abs = path ? resolveFilePath(path, cwd) : null;
    if (abs) named.add(abs);
  }
  for (const file of resultFiles(resultsOf(items, {}), cwd)) named.add(file);
  const files = [...named].filter((file) => !isUnder(file, root));
  const dirs = new Set<string>();
  for (const file of files) {
    if (!/\.html?$/i.test(file)) continue;
    const dir = file.slice(0, file.lastIndexOf("/"));
    if (dir && !isUnder(root, dir)) dirs.add(dir);
  }
  return { files: files.slice(-MAX_OUTSIDE_FILES), dirs: [...dirs].slice(-MAX_OUTSIDE_DIRS) };
}

export interface ContextCategory {
  name: string;
  tokens: number;
}

export interface ContextSummary {
  used: ContextCategory[];
  totalTokens: number;
  maxTokens: number;
  /** Tokens left before auto-compact starts. */
  free?: number;
  percentage?: number;
}

/** get_context_usage's answer, as the panel shows it. */
export function contextOf(usage: unknown): ContextSummary | null {
  const body = rec(usage);
  if (!body || !Array.isArray(body.categories)) return null;
  const used: ContextCategory[] = [];
  let free: number | undefined;
  for (const raw of body.categories) {
    const category = rec(raw);
    const name = str(category?.name);
    const tokens = category?.tokens;
    if (!category || !name || typeof tokens !== "number") continue;
    if (category.kind === "free") free = tokens;
    else if (category.kind === "used") used.push({ name, tokens });
  }
  const totalTokens = typeof body.totalTokens === "number" ? body.totalTokens : 0;
  const maxTokens = typeof body.maxTokens === "number" ? body.maxTokens : 0;
  return {
    used,
    totalTokens,
    maxTokens,
    ...(free !== undefined ? { free } : {}),
    ...(typeof body.percentage === "number" ? { percentage: body.percentage } : {}),
  };
}

export interface UsageLimit {
  kind: string;
  /** What a scoped limit covers: a model's name. */
  scope?: string;
  percent: number;
  resetsAt?: string;
  active: boolean;
}

/** get_usage's limits, as the server sends them. */
export function usageLimitsOf(usage: unknown): UsageLimit[] {
  const limits = rec(rec(usage)?.rate_limits)?.limits;
  if (!Array.isArray(limits)) return [];
  return limits.flatMap((raw) => {
    const limit = rec(raw);
    const kind = str(limit?.kind);
    if (!limit || !kind || typeof limit.percent !== "number") return [];
    const scope = rec(rec(limit.scope)?.model);
    return [
      {
        kind,
        ...(str(scope?.display_name) ? { scope: str(scope?.display_name) } : {}),
        percent: limit.percent,
        resetsAt: str(limit.resets_at),
        active: limit.is_active === true,
      },
    ];
  });
}
