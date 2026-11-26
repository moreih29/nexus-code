import { RELAY_MARK } from "../../../shared/chat/relay";
import type { AgentRun } from "../../../shared/claude/activity";
import { isAutoMountPath, isNetworkLink } from "../../../shared/fs/outside-url";
import { isUnder, isWindowsPath, slashWindowsPath } from "../../../shared/fs/relative-path";
import type { FileLinkSource, LinkedFile } from "./chat-files";
import { attachmentTarget, isFolder, splitAttachments } from "./composer-input";
import { imageFileOf, type ShownImage } from "./image-look";
import { linkPlaceIndex, linkPlaces } from "./link-places";
import { fileKind, resolveFilePath } from "./links";
import {
  type AssistantBlock,
  type AssistantItem,
  type ChatItem,
  type ChatModel,
  type ImageBlock,
  opensTurn,
  type TaskInfo,
  type ToolCall,
  type UserItem,
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

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export const AGENT_TOOLS = new Set(["Agent", "Task"]);

const AGENT_TASK_TYPES = new Set([
  "local_agent",
  "remote_agent",
  "in_process_teammate",
  "codex_subagent",
]);

export type AgentStatus = "running" | "completed" | "failed" | "stopped";

export interface AgentRow {
  toolUseId: string;
  taskId?: string;
  description: string;
  subagentType?: string;
  model?: string;
  status: AgentStatus;
  startedAt?: number;
  endedAt?: number;
  toolCount: number;
  currentTool?: string;
  lastText?: string;
  prompt?: string;
  teammate: boolean;
  endpoint?: string;
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

interface CallTimes {
  started: Map<string, number>;
  ended: Map<string, { at?: number; status: string }>;
}

function callTimesOf(items: readonly ChatItem[]): CallTimes {
  const started = new Map<string, number>();
  const ended = new Map<string, { at?: number; status: string }>();
  for (const item of items) {
    if (item.kind === "task_end" && item.toolUseId) {
      ended.set(item.toolUseId, { at: item.at, status: item.status });
    } else if (item.kind === "assistant" && item.at !== undefined) {
      for (const block of item.blocks) {
        if (block.type === "tool") started.set(block.toolUseId, item.at);
      }
    }
  }
  return { started, ended };
}

function endStatus(status: string): AgentStatus {
  return status === "completed" ? "completed" : status === "failed" ? "failed" : "stopped";
}

export function agentsOf(
  model: Pick<ChatModel, "tasks" | "tools" | "agentItems" | "items">,
): AgentRow[] {
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
  let times: CallTimes | undefined;
  const row = (toolUseId: string, tool: ToolCall | undefined, task: TaskInfo | undefined) => {
    seen.add(toolUseId);
    const input = rec(tool?.input) ?? {};
    const structured = rec(tool?.result?.structured);
    const own = children.get(toolUseId) ?? [];
    const running = [...own].reverse().find((t) => t.status === "running");
    const lastText = lastTextOf(model.agentItems[toolUseId]);
    let status = agentStatus(task, tool);
    let startedAt = task?.startedAt;
    let endedAt = task?.endedAt;
    if (!task && tool) {
      times ??= callTimesOf(model.items);
      startedAt = times.started.get(toolUseId);
      const end = times.ended.get(toolUseId);
      const took = num(structured?.totalDurationMs);
      if (end && status !== "running") status = endStatus(end.status);
      endedAt =
        end?.at ??
        (startedAt !== undefined && took !== undefined && status !== "running"
          ? startedAt + took
          : undefined);
    }
    rows.push({
      toolUseId,
      taskId: task?.type === "codex_subagent" ? undefined : task?.taskId,
      description: task?.description || str(input.description) || tool?.name || "",
      subagentType: task?.subagentType ?? str(input.subagent_type),
      model: str(structured?.resolvedModel) ?? str(input.model),
      status,
      startedAt,
      endedAt,
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
  for (const task of Object.values(model.tasks)) {
    if (!AGENT_TASK_TYPES.has(task.type)) continue;
    const id = task.toolUseId ?? task.taskId;
    if (!seen.has(id)) row(id, undefined, task);
  }
  return rows;
}

export function pastAgentsOf(
  history: Pick<ChatModel, "tasks" | "tools" | "agentItems" | "items">,
): AgentRow[] {
  return agentsOf(history).map((agent) =>
    agent.status === "running" ? { ...agent, status: "stopped" } : agent,
  );
}

export function joinAgents(
  past: readonly AgentRow[],
  live: readonly AgentRow[],
  runs: readonly AgentRow[],
): AgentRow[] {
  if (past.length === 0) return runs.length === 0 ? (live as AgentRow[]) : [...live, ...runs];
  const now = new Set(live.map((agent) => agent.toolUseId));
  return [...past.filter((agent) => !now.has(agent.toolUseId)), ...live, ...runs];
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

export function agentTranscript(model: Pick<ChatModel, "agentItems">, agent: AgentRow): ChatItem[] {
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

export function jobsOf(model: Pick<ChatModel, "tasks">): TaskInfo[] {
  return Object.values(model.tasks).filter((task) => !AGENT_TASK_TYPES.has(task.type));
}

export function exitCodeOf(summary: string | undefined): number | undefined {
  const code = summary?.match(/exit code (-?\d+)/i)?.[1];
  return code === undefined ? undefined : Number(code);
}

export function jobCommand(
  job: Pick<TaskInfo, "toolUseId">,
  tools: Record<string, ToolCall>,
): string | undefined {
  const tool = job.toolUseId ? tools[job.toolUseId] : undefined;
  return str(rec(tool?.input)?.command);
}

export function jobOutputFile(job: TaskInfo, tools: Record<string, ToolCall>): string | undefined {
  if (job.outputFile) return job.outputFile;
  const text = job.toolUseId ? tools[job.toolUseId]?.result?.text : undefined;
  const path = text?.match(/Output is being written to: (\S+)/)?.[1]?.replace(/\.$/, "");
  return path || undefined;
}

export function jobOutputFiles(
  model: Pick<ChatModel, "tasks">,
  tools: Record<string, ToolCall>,
): string[] {
  return jobsOf(model).flatMap((job) => {
    const path = jobOutputFile(job, tools);
    return path ? [path] : [];
  });
}

export interface TodoItem {
  id: string;
  content: string;
  status: string;
}

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
  rawPath?: string;
  added: number;
  removed: number;
  created: boolean;
  before?: string | null;
  toolUseIds: string[];
}

export function changedFilesOf(tools: Record<string, ToolCall>): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  for (const tool of Object.values(tools)) {
    if (!EDIT_TOOLS.has(tool.name) || tool.status !== "done") continue;
    const input = rec(tool.input) ?? {};
    const named = str(input.file_path) ?? str(input.notebook_path);
    if (!named) continue;
    const path = slashWindowsPath(named);
    const structured = rec(tool.result?.structured);
    const file = files.get(path) ?? {
      path,
      ...(named !== path ? { rawPath: named } : {}),
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

export function editCounts(tool: ToolCall): { added: number; removed: number } | undefined {
  if (!EDIT_TOOLS.has(tool.name) || tool.status !== "done") return undefined;
  const structured = rec(tool.result?.structured);
  if (structured?.type === "create") {
    return { added: lineCount(str(rec(tool.input)?.content) ?? ""), removed: 0 };
  }
  return patchCounts(structured?.structuredPatch);
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
  target: string;
  created: boolean;
}

const resultSources = new WeakMap<ResultEntry, FileLinkSource>();

export function resultSource(result: ResultEntry): FileLinkSource | undefined {
  return resultSources.get(result);
}

const URL_RE = /\bhttps?:\/\/[^\s<>()[\]"'`]+[^\s<>()[\]"'`.,;:!?]/g;
const LINK_RE = /\]\((<[^>\n]+>|[^)\s]+)\)/g;
const IMAGE_RE = /!\[[^\]]*\]\((<[^>\n]+>|[^)\s]+)\)/g;
const CODE_RE = /`([^`\n]+)`/g;

const EXTENSION_RE = /\.[A-Za-z0-9]{1,8}$/;

function linkTarget(match: RegExpMatchArray): string {
  const target = match[1];
  return target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target;
}

function looksLikePath(text: string): boolean {
  if (/[\r\n\t]/.test(text) || text.length > 300) return false;
  const path = text.replace(/[#?].*$/, "").replace(/:\d+(?::\d+)?$/, "");
  if (path.startsWith("/") || path.startsWith("~/")) {
    if (/^\/[^/]+$/.test(path) && !EXTENSION_RE.test(path)) return false;
    return path.length > 1;
  }
  if (/^[A-Za-z]:[\\/]/.test(path)) return path.length > 3;
  if (path.startsWith("file:///")) return path.length > "file:///".length;
  return /^[\w. %-]+([\\/][\w. %-]+)*\.[A-Za-z0-9]{1,8}$/.test(path);
}

const FILE_TOOLS = new Set([
  "Read",
  "NotebookRead",
  "ViewImage",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
]);

export const SEND_FILES_TOOL = "SendUserFile";

export function sentFilesOf(tool: ToolCall): string[] {
  if (tool.name !== SEND_FILES_TOOL) return [];
  const files = rec(tool.input)?.files;
  return Array.isArray(files)
    ? files.filter((file): file is string => typeof file === "string" && file !== "")
    : [];
}

function pathKey(path: string): string {
  return /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path;
}

export function touchedFiles(tools: Record<string, ToolCall>, cwd: string): Set<string> {
  const touched = new Set<string>();
  const take = (named: string) => {
    const path = resolveFilePath(named, cwd);
    if (path) touched.add(pathKey(path));
  };
  for (const tool of Object.values(tools)) {
    for (const file of sentFilesOf(tool)) take(file);
    if (!FILE_TOOLS.has(tool.name)) continue;
    const input = rec(tool.input);
    const named = str(input?.file_path) ?? str(input?.notebook_path);
    if (named) take(named);
  }
  return touched;
}

export function resultsOf(
  items: ChatItem[],
  tools: Record<string, ToolCall>,
  cwd: string,
  touched: ReadonlySet<string> = touchedFiles(tools, cwd),
): ResultEntry[] {
  const results: ResultEntry[] = [];
  const byTarget = new Map<string, ResultEntry>();
  const add = (
    kind: ResultEntry["kind"],
    target: string,
    source: FileLinkSource,
    created = false,
  ) => {
    if (byTarget.has(target)) return;
    const entry: ResultEntry = { kind, target, created };
    resultSources.set(entry, source);
    byTarget.set(target, entry);
    results.push(entry);
  };
  const tookIt = (text: string) => {
    const path = resolveFilePath(text, cwd);
    return path !== null && touched.has(pathKey(path));
  };
  for (const tool of Object.values(tools)) {
    if (tool.status !== "done") continue;
    const called: FileLinkSource = { kind: "tool", toolUseId: tool.id };
    for (const file of sentFilesOf(tool)) add("file", file, called);
    if (tool.name !== "Write") continue;
    const path = str(rec(tool.input)?.file_path);
    if (path && rec(tool.result?.structured)?.type === "create") add("file", path, called, true);
  }
  for (const item of items) {
    if (item.kind !== "assistant") continue;
    const answer: FileLinkSource = { kind: "answer", itemKey: item.key };
    for (const block of item.blocks) {
      if (block.type !== "text") continue;
      for (const match of block.text.matchAll(LINK_RE)) {
        const target = linkTarget(match);
        if (/^https?:\/\//.test(target)) add("url", target, answer);
        else if (looksLikePath(target)) add("file", target, answer);
      }
      for (const match of block.text.matchAll(URL_RE)) add("url", match[0], answer);
      for (const match of block.text.matchAll(CODE_RE)) {
        const text = match[1];
        if (looksLikePath(text) && tookIt(text)) add("file", text, answer);
      }
    }
  }
  return results;
}

export function distinctResults(
  results: readonly ResultEntry[],
  cwd: string,
  pathOf: (target: string) => string | null = (target) => resolveFilePath(target, cwd),
): ResultEntry[] {
  const out: ResultEntry[] = [];
  const byPath = new Map<string, number>();
  for (const result of results) {
    const path = result.kind === "file" ? pathOf(result.target) : null;
    const key = path ? pathKey(path) : undefined;
    const at = key ? byPath.get(key) : undefined;
    if (at !== undefined) {
      if (result.created && !out[at].created) {
        const kept = out[at];
        out[at] = { ...kept, created: true };
        const source = resultSources.get(kept);
        if (source) resultSources.set(out[at], source);
      }
      continue;
    }
    if (key) byPath.set(key, out.length);
    out.push(result);
  }
  return out;
}

const filesByItem = new WeakMap<UserItem, { cwd: string; files: string[] }>();

export function attachedFilesOf(item: UserItem, cwd: string): string[] {
  if (item.optimistic || item.text.startsWith(RELAY_MARK)) return [];
  const known = filesByItem.get(item);
  if (known?.cwd === cwd) return known.files;
  const files = splitAttachments(item.text).files.flatMap((named) => {
    const path = isFolder(named) ? null : resolveFilePath(attachmentTarget(named), cwd);
    return path ? [path] : [];
  });
  filesByItem.set(item, { cwd, files });
  return files;
}

export function attachedImagesOf(item: UserItem, cwd: string): string[] {
  return attachedFilesOf(item, cwd).filter((path) => fileKind(path) === "image");
}

export function attachedFilesIn(items: readonly ChatItem[], cwd: string): string[] {
  const files = new Set<string>();
  for (const item of items) {
    if (item.kind === "user") for (const file of attachedFilesOf(item, cwd)) files.add(file);
  }
  return [...files];
}

const MAX_AGENT_DEPTH = 4;

const LOOK_TOOLS = new Set(["Read", "ViewImage"]);

export function imagesOf(
  items: readonly ChatItem[],
  tools: Record<string, ToolCall>,
  cwd: string,
  agentItems: Readonly<Record<string, readonly ChatItem[]>> = {},
  served: (attached: string) => boolean = () => false,
): ShownImage[] {
  const out: ShownImage[] = [];
  const byFile = new Map<string, number>();
  const seen = new Set<ImageBlock>();
  const touched = touchedFiles(tools, cwd);
  const addFile = (named: string, image?: ImageBlock, placed?: ReadonlySet<string>) => {
    const file = resolveFilePath(named, cwd);
    if (!file || fileKind(file) !== "image") return;
    if (image) {
      if (seen.has(image)) return;
      seen.add(image);
    }
    const shows = placed?.has(file) === true;
    const at = byFile.get(file);
    if (at === undefined) {
      byFile.set(file, out.length);
      out.push(image ? { file, image } : { file, ...(shows ? { placed: true } : {}) });
    } else if (image && !out[at].image) {
      out[at] = { ...out[at], image };
    } else if (image) {
      byFile.set(file, out.length);
      out.push({ file, image });
    } else if (shows && !out[at].placed) {
      out[at] = { ...out[at], placed: true };
    }
  };
  const addData = (image: ImageBlock) => {
    if (seen.has(image)) return;
    seen.add(image);
    out.push({ image });
  };
  const walk = (items: readonly ChatItem[], depth: number) => {
    for (const item of items) {
      if (item.kind === "user") {
        for (const image of item.images) addData(image);
        const attached = attachedImagesOf(item, cwd);
        const placed = new Set(attached.filter(served));
        for (const file of attached) addFile(file, undefined, placed);
        continue;
      }
      if (item.kind !== "assistant") continue;
      for (const block of item.blocks) {
        if (block.type === "text") {
          const placed = new Set(placedImages(block, tools, cwd));
          for (const named of filesNamedIn(block.text, cwd, touched)) {
            addFile(named, undefined, placed);
          }
          continue;
        }
        const tool = block.type === "tool" ? tools[block.toolUseId] : undefined;
        if (!tool) continue;
        const read = imageFileOf(tool.input);
        const given = tool.result?.images ?? [];
        for (const image of given) {
          if (read) addFile(read, image);
          else addData(image);
        }
        if (read && given.length === 0 && LOOK_TOOLS.has(tool.name)) addFile(read);
        const sent = new Set(placedImages(block, tools, cwd));
        for (const file of sentFilesOf(tool)) addFile(file, undefined, sent);
        const written = str(rec(tool.input)?.file_path);
        if (tool.name === "Write" && tool.status === "done" && written) {
          if (rec(tool.result?.structured)?.type === "create") addFile(written);
        }
        const nested = agentItems[tool.id];
        if (nested && depth < MAX_AGENT_DEPTH) walk(nested, depth + 1);
      }
    }
  };
  walk(items, 0);
  return out;
}

function filesNamedIn(text: string, cwd: string, touched: ReadonlySet<string>): string[] {
  const named: { at: number; path: string }[] = [];
  for (const match of text.matchAll(LINK_RE)) {
    const target = linkTarget(match);
    if (!/^https?:\/\//.test(target) && looksLikePath(target)) {
      named.push({ at: match.index, path: target });
    }
  }
  for (const match of text.matchAll(CODE_RE)) {
    const path = looksLikePath(match[1]) ? resolveFilePath(match[1], cwd) : null;
    if (path && touched.has(pathKey(path))) named.push({ at: match.index, path: match[1] });
  }
  return named.sort((a, b) => a.at - b.at).map(({ path }) => path);
}

function placedImages(
  block: AssistantBlock,
  tools: Record<string, ToolCall>,
  cwd: string,
): string[] {
  let named: string[] = [];
  if (block.type === "text") named = [...block.text.matchAll(IMAGE_RE)].map(linkTarget);
  else if (block.type === "tool" && tools[block.toolUseId]?.status === "done") {
    named = sentFilesOf(tools[block.toolUseId]);
  }
  return named.flatMap((target) => {
    const path = resolveFilePath(target, cwd);
    return path && fileKind(path) === "image" ? [path] : [];
  });
}

export interface ImagesShownEarlier {
  byPart: ReadonlyMap<AssistantBlock | string, ReadonlySet<string>>;
  inLastTurn: ReadonlySet<string>;
}

export function imagesShownEarlier(
  items: readonly ChatItem[],
  tools: Record<string, ToolCall>,
  cwd: string,
): ImagesShownEarlier {
  const byPart = new Map<AssistantBlock | string, ReadonlySet<string>>();
  let seen = new Set<string>();
  for (const item of items) {
    if (opensTurn(item)) {
      seen = new Set();
      continue;
    }
    if (item.kind !== "assistant") continue;
    for (const block of item.blocks) {
      const files = placedImages(block, tools, cwd);
      if (files.length === 0) continue;
      const again = new Set(files.filter((file) => seen.has(file)));
      if (again.size > 0) byPart.set(block.type === "tool" ? block.toolUseId : block, again);
      for (const file of files) seen.add(file);
    }
  }
  return { byPart, inLastTurn: seen };
}

export interface GivenImage {
  image: ImageBlock;
  file?: string;
}

export interface AnswerExtras {
  files: string[];
  elsewhere?: Record<string, string[]>;
  images: GivenImage[];
}

const answerLinkMaps = new WeakMap<AnswerExtras, Readonly<Record<string, LinkedFile>>>();

export function answerLinks(extras: AnswerExtras): Readonly<Record<string, LinkedFile>> {
  return answerLinkMaps.get(extras) ?? {};
}

export const MAX_ANSWER_FILES = 8;
export const MAX_ANSWER_IMAGES = 4;

export function answerExtras(
  items: ChatItem[],
  tools: Record<string, ToolCall>,
  cwd: string,
  root: string,
  lastDone: boolean,
  cardsAnywhere = false,
): Map<ChatItem, AnswerExtras> {
  const out = new Map<ChatItem, AnswerExtras>();
  const touched = touchedFiles(tools, cwd);
  const places = linkPlaceIndex(tools, cwd);
  let turn: ChatItem[] = [];
  const close = () => {
    const answer = [...turn].reverse().find((item) => item.kind === "assistant");
    if (!answer) return;
    const named: string[] = [];
    const sources = new Map<string, FileLinkSource>();
    const given: (GivenImage & { from?: string; call: string })[] = [];
    const shown = new Set<string>();
    const showHere = (target: string) => {
      const path = resolveFilePath(target, cwd);
      if (path) shown.add(path);
    };
    for (const item of turn) {
      if (item.kind !== "assistant") continue;
      for (const block of item.blocks) {
        if (block.type === "text") {
          for (const match of block.text.matchAll(IMAGE_RE)) showHere(linkTarget(match));
        }
        const tool = block.type === "tool" ? tools[block.toolUseId] : undefined;
        if (!tool) continue;
        for (const file of sentFilesOf(tool)) showHere(file);
        const path = str(rec(tool.input)?.file_path);
        const from = path ? (resolveFilePath(path, cwd) ?? undefined) : undefined;
        const file = from && fileKind(from) === "image" ? from : undefined;
        for (const image of tool.result?.images ?? [])
          given.push({ image, from, file, call: tool.id });
        if (tool.name === "Write" && tool.status === "done" && path) {
          if (rec(tool.result?.structured)?.type === "create") {
            named.push(path);
            if (!sources.has(path)) sources.set(path, { kind: "tool", toolUseId: tool.id });
          }
        }
      }
    }
    for (const result of resultsOf(turn, {}, cwd, touched)) {
      if (result.kind !== "file") continue;
      named.push(result.target);
      const source = resultSources.get(result);
      if (source && !sources.has(result.target)) sources.set(result.target, source);
    }
    const files: string[] = [];
    const elsewhere: Record<string, string[]> = {};
    const links: Record<string, LinkedFile> = {};
    for (const target of named) {
      const [path, ...others] = linkPlaces(target, places).map((place) => place.path);
      if (!path || shown.has(path) || files.includes(path)) continue;
      files.push(path);
      if (others.length > 0) elsewhere[path] = others;
      const source = sources.get(target);
      if (source) links[path] = { href: target, source };
    }
    const lastRead = new Map<string, string>();
    for (const { from, call } of given) if (from) lastRead.set(from, call);
    const carded = (from: string) => files.includes(from) && (cardsAnywhere || isUnder(from, root));
    const images = given
      .filter(
        ({ from, call }) =>
          !from || (lastRead.get(from) === call && !shown.has(from) && !carded(from)),
      )
      .map(({ image, file }) => (file ? { image, file } : { image }));
    if (files.length > 0 || images.length > 0) {
      const extras: AnswerExtras = {
        files,
        ...(Object.keys(elsewhere).length > 0 ? { elsewhere } : {}),
        images: images.slice(0, MAX_ANSWER_IMAGES),
      };
      answerLinkMaps.set(extras, links);
      out.set(answer, extras);
    }
  };
  for (const item of items) {
    if (opensTurn(item)) {
      close();
      turn = [];
    } else turn.push(item);
  }
  if (lastDone) close();
  return out;
}

export interface OutsideLinks {
  files: string[];
  opened: string[];
}

export const MAX_OUTSIDE_FILES = 2000;

export function outsideLinksOf(
  items: ChatItem[],
  tools: Record<string, ToolCall>,
  cwd: string,
  root: string,
  looked: readonly string[] = [],
  attached?: (file: string) => boolean,
  opened: readonly string[] = [],
): OutsideLinks {
  if (!root) return { files: [], opened: [] };
  const outside = (file: string) => !isUnder(file, root);
  const named = new Set<string>(looked.filter(outside));
  for (const tool of Object.values(tools)) {
    if (tool.status !== "done") continue;
    const input = rec(tool.input);
    const path = str(input?.file_path) ?? str(input?.notebook_path);
    for (const file of path ? [path, ...sentFilesOf(tool)] : sentFilesOf(tool)) {
      const abs = resolveFilePath(file, cwd);
      if (abs && outside(abs)) named.add(abs);
    }
  }
  for (const file of attachedFilesIn(items, cwd)) {
    if (outside(file) && (attached?.(file) ?? true)) named.add(file);
  }
  for (const file of outsideLinkedFiles(
    items,
    tools,
    cwd,
    root,
    (target) => !isNetworkLink(target),
  )) {
    if (fileKind(file) === "image") named.add(file);
  }
  return {
    files: [...named].filter((file) => !isAutoMountPath(file)).slice(-MAX_OUTSIDE_FILES),
    opened: [...new Set(opened.filter(outside))].slice(-MAX_OUTSIDE_FILES),
  };
}

export function outsideLinkedFiles(
  items: ChatItem[],
  tools: Record<string, ToolCall>,
  cwd: string,
  root: string,
  keep: (target: string) => boolean = () => true,
): string[] {
  if (!root) return [];
  const named = new Set<string>();
  const places = linkPlaceIndex(tools, cwd);
  for (const result of resultsOf(items, {}, cwd, touchedFiles(tools, cwd))) {
    if (result.kind !== "file" || !keep(result.target)) continue;
    for (const place of linkPlaces(result.target, places)) {
      if (!isUnder(place.path, root)) named.add(place.path);
    }
  }
  return [...named].slice(-MAX_OUTSIDE_FILES);
}

export function hostedOutsideFiles(
  items: ChatItem[],
  tools: Record<string, ToolCall>,
  cwd: string,
  root: string,
  attached?: (file: string) => boolean,
): string[] {
  if (!root) return [];
  const named = new Set<string>();
  for (const tool of Object.values(tools)) {
    const input = rec(tool.input);
    const path = str(input?.file_path) ?? str(input?.notebook_path);
    for (const file of path ? [path, ...sentFilesOf(tool)] : sentFilesOf(tool)) {
      const abs = resolveFilePath(file, cwd);
      if (abs && !isUnder(abs, root)) named.add(abs);
    }
  }
  for (const file of outsideLinkedFiles(items, tools, cwd, root)) named.add(file);
  for (const file of outsideLinksOf(items, {}, cwd, root, [], attached).files) named.add(file);
  return [...named].slice(-MAX_OUTSIDE_FILES);
}

const SHARE_FILE = /^\/\/([^/]+)\/([^/]+)\/(.+)$/;

function onShare(path: string): boolean {
  const [, host, share, rest] = SHARE_FILE.exec(path) ?? [];
  if (!host || !share || !rest || /^[.?]+$/.test(host)) return false;
  return [share, ...rest.split("/")].every((part) => part !== "" && part !== "." && part !== "..");
}

export function changedShareFiles(tools: Record<string, ToolCall>, root: string): string[] {
  if (!isWindowsPath(root)) return [];
  return changedFilesOf(tools)
    .map((file) => file.path)
    .filter((path) => onShare(path) && !isUnder(path, root));
}

export interface ContextCategory {
  name: string;
  tokens: number;
}

export interface ContextSummary {
  used: ContextCategory[];
  totalTokens: number;
  maxTokens: number;
  free?: number;
  percentage?: number;
}

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

export { type UsageLimit, usageLimitsOf } from "./claude/usage-limits";
