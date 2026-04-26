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
  homeDir?: () => string;
  now?: () => Date;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SUMMARY_LIMIT = 240;

export class ClaudeSessionTranscriptService {
  private readonly readFile: (filePath: string, encoding: BufferEncoding) => Promise<string>;
  private readonly homeDir: () => string;
  private readonly now: () => Date;

  public constructor(options: ClaudeSessionTranscriptServiceOptions = {}) {
    this.readFile = options.readFile ?? readFileDefault;
    this.homeDir = options.homeDir ?? os.homedir;
    this.now = options.now ?? (() => new Date());
  }

  public async readTranscript(
    request: ClaudeTranscriptReadRequest,
  ): Promise<ClaudeTranscriptReadResult> {
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
