import type { AppError } from "../error/app-error";

export const IPC_RESULT_BRAND = "__nexusIpcResult_a3f8b1d2" as const;

export type IpcResultKind =
  | "not-found"
  | "cancelled"
  | "session-expired"
  | "auth-failed"
  | "permission-denied"
  | "conflict"
  | "invalid-args"
  | (string & {});

export interface IpcOkResult<T = unknown> {
  readonly [IPC_RESULT_BRAND]: true;
  readonly ok: true;
  readonly value: T;
}

export interface IpcErrResult<K extends IpcResultKind = IpcResultKind> {
  readonly [IPC_RESULT_BRAND]: true;
  readonly ok: false;
  readonly kind: K;
  readonly message: string;
  readonly category?: AppError["category"];
  readonly domain?: AppError["domain"];
  readonly code?: string;
  readonly correlationId?: string;
}

export type IpcResult<T = unknown, K extends IpcResultKind = IpcResultKind> =
  | IpcOkResult<T>
  | IpcErrResult<K>;

export type IpcStreamStartResult = IpcResult<{ streamId: string }>;

export function isIpcResult(value: unknown): value is IpcResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[IPC_RESULT_BRAND] === true
  );
}

export function isIpcOkResult<T>(value: unknown): value is IpcOkResult<T> {
  return isIpcResult(value) && value.ok === true;
}

export function isIpcErrResult<K extends IpcResultKind = IpcResultKind>(
  value: unknown,
): value is IpcErrResult<K> {
  return isIpcResult(value) && value.ok === false;
}

export function ipcOk<T>(value: T): IpcOkResult<T> {
  return { [IPC_RESULT_BRAND]: true, ok: true, value };
}

export function ipcErr<K extends IpcResultKind>(
  kind: K,
  message: string,
  extra?: Record<string, unknown>,
): IpcErrResult<K> & Record<string, unknown> {
  return { [IPC_RESULT_BRAND]: true, ok: false, kind, message, ...extra };
}

export function ipcResultKindToCategory(
  kind: IpcResultKind,
): "invalid-input" | "cancelled" | "failed" {
  if (kind === "cancelled") return "cancelled";
  if (kind === "invalid-args") return "invalid-input";
  return "failed";
}

export function ipcErrorToAppError(error: IpcErrResult): AppError {
  const { category, domain, code, correlationId, message } = error;
  return {
    category: category ?? ipcResultKindToCategory(error.kind),
    domain,
    code,
    correlationId,
    message,
  };
}
