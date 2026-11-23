import type { IpcErrResult } from "../ipc/result";
import type { GitActionHint } from "./types";

export const GIT_IPC_ERROR_KIND = "git-error" as const;

export interface GitIpcErrorExtra {
  readonly gitKind: string;
  readonly stderr: string;
  readonly argv: readonly string[];
  readonly hint?: GitActionHint;
}

export type GitIpcErrorResult = IpcErrResult<typeof GIT_IPC_ERROR_KIND> & GitIpcErrorExtra;

export const IPC_GIT_ERROR_MARK = "__ipcGitError";

export const IPC_CALL_RESULT_MARK = "__ipcGitErrorResult";

export interface IpcGitErrorResult {
  readonly [IPC_CALL_RESULT_MARK]: true;
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly kind: string;
  readonly stderr: string;
  readonly argv: readonly string[];
  readonly hint?: GitActionHint;
}

export function isIpcGitErrorResult(value: unknown): value is IpcGitErrorResult {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.ok === false && v.kind === GIT_IPC_ERROR_KIND) return true;
  return v[IPC_CALL_RESULT_MARK] === true;
}

export function gitErrorFromIpcResult(result: IpcGitErrorResult): Error {
  const error = new Error(result.message);
  error.name = result.name || "GitError";
  if (result.stack) error.stack = result.stack;
  Object.assign(error, {
    kind: result.kind,
    stderr: result.stderr,
    argv: result.argv,
    hint: result.hint,
  });
  return error;
}

export interface IpcGitErrorPayload {
  readonly [IPC_GIT_ERROR_MARK]: true;
  readonly kind: string;
  readonly stderr: string;
  readonly argv: readonly string[];
  readonly hint?: GitActionHint;
}

export function isIpcGitErrorPayload(value: unknown): value is IpcGitErrorPayload {
  if (!value || typeof value !== "object") return false;
  return (value as Record<string, unknown>)[IPC_GIT_ERROR_MARK] === true;
}

export function rehydrateGitErrorFromCause(error: Error): Error {
  const cause = (error as { cause?: unknown }).cause;
  if (!isIpcGitErrorPayload(cause)) return error;

  Object.assign(error, {
    kind: cause.kind,
    stderr: cause.stderr,
    argv: cause.argv,
    hint: cause.hint,
  });
  return error;
}
