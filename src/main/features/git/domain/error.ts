import {
  AGENT_REQUEST_FAILED_CODE,
  AgentGitFailureDataSchema,
  type AgentGitRunResult,
} from "../../../../shared/git/protocol";
import type { GitActionHint, GitErrorKind } from "../../../../shared/git/types";

export type { GitErrorKind };

export interface GitErrorOptions {
  readonly stderr?: string;
  readonly stdout?: string;
  readonly code?: number | null;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly argv?: readonly string[];
  readonly cause?: unknown;
  readonly hint?: GitActionHint;
}

export class GitError extends Error {
  readonly kind: GitErrorKind;
  readonly stderr: string;
  readonly stdout: string;
  readonly code: number | null;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly argv: readonly string[];
  readonly hint?: GitActionHint;

  constructor(kind: GitErrorKind, message: string, options: GitErrorOptions = {}) {
    super(maskCredentials(message), { cause: options.cause });
    this.name = "GitError";
    this.kind = kind;
    this.stderr = maskCredentials(options.stderr ?? "");
    this.stdout = options.stdout ?? "";
    this.code = options.code ?? options.exitCode ?? null;
    this.exitCode = this.code;
    this.signal = options.signal ?? null;
    this.argv = options.argv?.map(maskArgument) ?? [];
    this.hint = options.hint;
  }
}

function maskCredentials(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s?#"'<>]+@/gi, "$1[REDACTED]@")
    .replace(
      /(\bauthorization\b["']?\s*[:=]\s*["']?(?:(?:bearer|basic|token)\s+)?|\bbearer\s+)[^\s"';,]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(\b(?:token|[a-z0-9_]+_(?:key|token|secret))\b["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s"'&;,<>]+)/gi,
      "$1[REDACTED]",
    );
}

function maskArgument(arg: string): string {
  return maskCredentials(
    arg.replace(/(^|\s)([a-z0-9_]+_(?:key|token|secret)\s*=)[\s\S]+$/i, "$1$2[REDACTED]"),
  );
}

export function gitErrorFromAgent(
  result: AgentGitRunResult,
  args: readonly string[],
  cause?: unknown,
): GitError {
  const kind = result.errorKind ?? "unknown";
  return new GitError(kind, agentGitErrorMessage(result, args), {
    argv: args,
    stderr: result.stderr,
    stdout: result.stdout,
    code: result.code,
    exitCode: result.code,
    signal: null,
    hint: result.errorHint,
    cause,
  });
}

export function gitErrorFromAgentError(error: unknown): GitError | undefined {
  if (!(error instanceof Error)) return undefined;
  const { code, data } = error as Error & { code?: unknown; data?: unknown };
  if (code !== AGENT_REQUEST_FAILED_CODE) return undefined;
  const failure = AgentGitFailureDataSchema.safeParse(data);
  return new GitError(failure.success ? failure.data.errorKind : "unknown", error.message, {
    hint: failure.success ? failure.data.errorHint : undefined,
    cause: error,
  });
}

export function gitErrorFromExit(options: {
  readonly args: readonly string[];
  readonly stderr: string;
  readonly stdout?: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}): GitError {
  return new GitError(
    "unknown",
    processExitMessage(options.args, options.stderr, options.exitCode, options.signal),
    {
      argv: options.args,
      stderr: options.stderr,
      stdout: options.stdout,
      code: options.exitCode,
      exitCode: options.exitCode,
      signal: options.signal,
    },
  );
}

export function outputTooLargeGitError(options: {
  readonly args: readonly string[];
  readonly limitBytes: number;
  readonly stderr?: string;
}): GitError {
  return new GitError(
    "output-too-large",
    `Git output exceeded ${formatBytes(options.limitBytes)} limit`,
    {
      argv: options.args,
      stderr: options.stderr,
    },
  );
}

export function gitMissingError(bin: string, args: readonly string[], cause?: unknown): GitError {
  return new GitError("git-missing", `Git executable not found: ${bin}`, {
    argv: args,
    cause,
  });
}

export function unknownGitError(
  message: string,
  args: readonly string[],
  cause?: unknown,
): GitError {
  return new GitError("unknown", message, {
    argv: args,
    cause,
  });
}

function agentGitErrorMessage(result: AgentGitRunResult, args: readonly string[]): string {
  const agentMessage = result.errorMessage?.trim();
  if (agentMessage) return agentMessage;
  return processExitMessage(args, result.stderr, result.code, null);
}

function processExitMessage(
  args: readonly string[],
  stderr: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): string {
  const trimmed = stderr.trim();
  if (trimmed.length > 0) return trimmed;
  const renderedCommand = renderGitCommand(args.map(maskArgument));
  if (signal) return `${renderedCommand} exited with signal ${signal}`;
  if (exitCode !== null) return `${renderedCommand} exited with code ${exitCode}`;
  return `${renderedCommand} failed`;
}

function renderGitCommand(args: readonly string[]): string {
  return ["git", ...args].join(" ");
}

function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return `${mib.toFixed(Number.isInteger(mib) ? 0 : 1)} MB`;
}
