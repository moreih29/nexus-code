import { readFile as readFileDefault } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  ClaudeTranscriptEntry,
  ClaudeTranscriptReadRequest,
  ClaudeTranscriptReadResult,
} from "../../../shared/src/contracts/e3-surfaces";

export interface ClaudeSessionTranscriptServiceOptions {
  readFile?: (filePath: string, encoding: BufferEncoding) => Promise<string>;
  fetchFn?: typeof fetch;
  homeDir?: () => string;
  now?: () => Date;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SUMMARY_LIMIT = 240;
const OPENCODE_TRANSCRIPT_PROTOCOL = "opencode:";

export class ClaudeSessionTranscriptService {
  private readonly readFile: (filePath: string, encoding: BufferEncoding) => Promise<string>;
  private readonly fetchFn: typeof fetch;
  private readonly homeDir: () => string;
  private readonly now: () => Date;

  public constructor(options: ClaudeSessionTranscriptServiceOptions = {}) {
    this.readFile = options.readFile ?? readFileDefault;
    this.fetchFn = options.fetchFn ?? fetch;
    this.homeDir = options.homeDir ?? os.homedir;
    this.now = options.now ?? (() => new Date());
  }

  public async readTranscript(
    request: ClaudeTranscriptReadRequest,
  ): Promise<ClaudeTranscriptReadResult> {
    if (isOpenCodeTranscriptPath(request.transcriptPath)) {
      return this.readOpenCodeTranscript(request);
    }

    const validation = this.validateTranscriptPath(request.transcriptPath);
    if (!validation.ok) {
      return this.unavailable(validation.reason, request.transcriptPath);
    }

    try {
      const content = await this.readFile(validation.absolutePath, "utf8");
      return {
        available: true,
        transcriptPath: validation.absolutePath,
        entries: parseTranscriptJsonl(content, normalizeLimit(request.limit ?? undefined)),
        readAt: this.timestamp(),
      };
    } catch {
      return this.unavailable("Unable to read session transcript.", validation.absolutePath);
    }
  }

  private async readOpenCodeTranscript(
    request: ClaudeTranscriptReadRequest,
  ): Promise<ClaudeTranscriptReadResult> {
    const parsed = parseOpenCodeTranscriptPath(request.transcriptPath);
    if (!parsed.ok) {
      return this.unavailable(parsed.reason, request.transcriptPath);
    }

    const limit = normalizeLimit(request.limit ?? undefined);
    const url = `http://${parsed.host}:${parsed.port}/session/${encodeURIComponent(parsed.sessionId)}/message?limit=${limit}`;
    try {
      const response = await this.fetchFn(url, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        return this.unavailable(`OpenCode session API responded with HTTP ${response.status}.`, request.transcriptPath);
      }

      const payload = await response.json() as unknown;
      const entries = parseOpenCodeSessionMessages(payload, limit);
      return {
        available: true,
        transcriptPath: request.transcriptPath,
        entries,
        readAt: this.timestamp(),
      };
    } catch {
      return this.unavailable("Unable to read OpenCode session messages.", request.transcriptPath);
    }
  }

  private validateTranscriptPath(
    transcriptPath: string,
  ):
    | { ok: true; absolutePath: string }
    | { ok: false; reason: string } {
    if (typeof transcriptPath !== "string" || transcriptPath.trim().length === 0) {
      return { ok: false, reason: "transcriptPath is required." };
    }

    if (!path.isAbsolute(transcriptPath)) {
      return { ok: false, reason: "Session transcript path must be absolute." };
    }

    const absolutePath = path.resolve(transcriptPath);
    const allowedRoots = [
      path.resolve(this.homeDir(), ".claude", "projects"),
      path.resolve(this.homeDir(), ".codex"),
    ];
    const isInsideAllowedRoot = allowedRoots.some((root) => isPathInsideRoot(root, absolutePath));

    if (!isInsideAllowedRoot) {
      return { ok: false, reason: "Session transcript path is outside allowed Claude/Codex roots." };
    }

    if (path.extname(absolutePath) !== ".jsonl") {
      return { ok: false, reason: "Session transcript path must be a .jsonl file." };
    }

    return { ok: true, absolutePath };
  }

  private unavailable(
    reason: string,
    transcriptPath?: string,
  ): ClaudeTranscriptReadResult {
    return {
      available: false,
      transcriptPath,
      reason,
      readAt: this.timestamp(),
    };
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

export function parseTranscriptJsonl(
  content: string,
  limit = DEFAULT_LIMIT,
): ClaudeTranscriptEntry[] {
  const entries = content
    .split(/\r?\n/)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.trim().length > 0)
    .map(({ line, lineNumber }) => parseTranscriptLine(line, lineNumber));

  return entries.slice(Math.max(0, entries.length - normalizeLimit(limit)));
}

export function parseOpenCodeSessionMessages(
  payload: unknown,
  limit = DEFAULT_LIMIT,
): ClaudeTranscriptEntry[] {
  const items = Array.isArray(payload) ? payload : [];
  const entries = items.map((item, index) => parseOpenCodeSessionMessage(item, index + 1));
  return entries.slice(Math.max(0, entries.length - normalizeLimit(limit)));
}

function parseTranscriptLine(line: string, lineNumber: number): ClaudeTranscriptEntry {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return {
      lineNumber,
      role: extractRole(parsed),
      kind: extractKind(parsed),
      summary: extractSummary(parsed),
      ...(typeof parsed.timestamp === "string" ? { timestamp: parsed.timestamp } : {}),
    };
  } catch {
    return {
      lineNumber,
      role: "unknown",
      kind: "invalid-json",
      summary: truncate(line.trim()),
    };
  }
}

function parseOpenCodeSessionMessage(item: unknown, lineNumber: number): ClaudeTranscriptEntry {
  const record = asRecord(item) ?? {};
  const info = asRecord(record.info) ?? record;
  const parts = Array.isArray(record.parts) ? record.parts : [];
  const role = typeof info.role === "string" ? info.role : "event";
  const timestamp = timestampFromOpenCodeTime(asRecord(info.time));

  return {
    lineNumber,
    role,
    kind: "opencode-message",
    summary: truncate(openCodeMessageSummary(info, parts) || JSON.stringify(item)),
    ...(timestamp ? { timestamp } : {}),
  };
}

function extractRole(value: Record<string, unknown>): string {
  const message = asRecord(value.message);
  const role = typeof message?.role === "string"
    ? message.role
    : typeof value.role === "string"
      ? value.role
      : typeof value.type === "string"
        ? value.type
        : "event";

  return role;
}

function extractKind(value: Record<string, unknown>): string {
  if (typeof value.type === "string") {
    return value.type;
  }
  if (typeof value.event === "string") {
    return value.event;
  }
  const message = asRecord(value.message);
  if (typeof message?.type === "string") {
    return message.type;
  }

  return "message";
}

function extractSummary(value: Record<string, unknown>): string {
  const message = asRecord(value.message);
  const content = message && "content" in message ? message.content : value.content;
  const summary = summarizeContent(content ?? value);
  return truncate(summary || JSON.stringify(value));
}

function summarizeContent(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value.map(summarizeContent).filter(Boolean).join(" ").trim();
  }

  const record = asRecord(value);
  if (!record) {
    return value == null ? "" : String(value);
  }

  if (typeof record.text === "string") {
    return record.text.trim();
  }
  if (typeof record.content === "string") {
    return record.content.trim();
  }
  if (typeof record.name === "string" && typeof record.type === "string") {
    return `${record.type}: ${record.name}`;
  }
  if (typeof record.type === "string") {
    return record.type;
  }

  return JSON.stringify(record);
}

function openCodeMessageSummary(
  info: Record<string, unknown>,
  parts: unknown[],
): string {
  const partSummary = parts.map(summarizeOpenCodePart).filter(Boolean).join(" ").trim();
  if (partSummary) {
    return partSummary;
  }

  const summary = asRecord(info.summary);
  return [summary?.title, summary?.body]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .trim();
}

function summarizeOpenCodePart(part: unknown): string {
  const record = asRecord(part);
  if (!record) {
    return "";
  }

  const type = typeof record.type === "string" ? record.type : "part";
  if (typeof record.text === "string") {
    return record.text.trim();
  }
  if (type === "tool") {
    const state = asRecord(record.state);
    const status = typeof state?.status === "string" ? state.status : undefined;
    const title = typeof state?.title === "string" ? state.title : undefined;
    const tool = typeof record.tool === "string" ? record.tool : "tool";
    return ["tool", tool, status, title].filter(Boolean).join(": ");
  }
  if (type === "reasoning" && typeof record.text === "string") {
    return record.text.trim();
  }
  return type;
}

function isPathInsideRoot(root: string, absolutePath: string): boolean {
  const relativePath = path.relative(root, absolutePath);
  return relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function normalizeLimit(limit: number | null | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_LIMIT;
  }

  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)));
}

function isOpenCodeTranscriptPath(transcriptPath: string): boolean {
  return typeof transcriptPath === "string" && transcriptPath.trim().startsWith(`${OPENCODE_TRANSCRIPT_PROTOCOL}//`);
}

function parseOpenCodeTranscriptPath(
  transcriptPath: string,
):
  | { ok: true; host: string; port: number; sessionId: string }
  | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(transcriptPath);
  } catch {
    return { ok: false, reason: "Invalid OpenCode transcript URL." };
  }

  if (url.protocol !== OPENCODE_TRANSCRIPT_PROTOCOL) {
    return { ok: false, reason: "Invalid OpenCode transcript protocol." };
  }

  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    return { ok: false, reason: "OpenCode transcript URL must target localhost." };
  }

  const port = Number.parseInt(url.port, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return { ok: false, reason: "OpenCode transcript URL must include a valid port." };
  }

  const match = /^\/session\/([^/]+)\/message$/u.exec(url.pathname);
  const sessionId = match ? decodeURIComponent(match[1]) : "";
  if (!sessionId) {
    return { ok: false, reason: "OpenCode transcript URL must include a session id." };
  }

  return { ok: true, host: url.hostname, port, sessionId };
}

function timestampFromOpenCodeTime(time: Record<string, unknown> | null): string | undefined {
  const value = time?.created ?? time?.completed;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const epochMs = value > 0 && value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return null;
}

function truncate(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= SUMMARY_LIMIT) {
    return trimmed;
  }

  return `${trimmed.slice(0, SUMMARY_LIMIT - 1)}…`;
}
