// Tiny shared helpers for the agent-backed LSP host. Kept in one file so
// the rest of the LSP modules can import predictable, dependency-free
// utilities without growing a deep import graph.

export type JsonRpcId = string | number | null;

export function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return isObjectLike(value) ? value : null;
}

export function jsonRpcId(value: unknown): JsonRpcId {
  if (typeof value === "string" || typeof value === "number" || value === null) return value;
  return null;
}

export function lspError(raw: unknown): Error {
  if (isObjectLike(raw) && typeof raw.message === "string") {
    return new Error(raw.message);
  }
  return new Error("LSP error");
}

export function abortError(): Error {
  const err = new Error("Request cancelled");
  err.name = "AbortError";
  return err;
}
