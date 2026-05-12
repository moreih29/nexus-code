import { FS_ERROR } from "../shared/fs-errors";
import { handleReaddir, handleReadFile, handleStat } from "./agent-fs-handlers";

export interface AgentRequest {
  readonly id: string;
  readonly method: string;
  readonly params?: unknown;
}

export interface AgentErrorFrame {
  readonly code: string;
  readonly message: string;
}

export type AgentResponse =
  | { readonly id: string; readonly result: unknown }
  | { readonly id: string; readonly error: AgentErrorFrame };

type AgentMethodHandler = (rootPath: string, params: unknown) => Promise<unknown>;

export const agentMethodHandlers = {
  "fs.readdir": handleReaddir,
  "fs.stat": handleStat,
  "fs.readFile": handleReadFile,
} satisfies Record<string, AgentMethodHandler>;

/**
 * Builds a root-bound dispatcher that Task 10 can exercise without stdio.
 */
export function createAgentDispatcher(
  rootPath: string,
  handlers: Readonly<Record<string, AgentMethodHandler>> = agentMethodHandlers,
): (request: AgentRequest) => Promise<AgentResponse> {
  return (request) => dispatchAgentRequest(rootPath, request, handlers);
}

/**
 * Dispatches one validated agent request to the matching method handler.
 */
export async function dispatchAgentRequest(
  rootPath: string,
  request: AgentRequest,
  handlers: Readonly<Record<string, AgentMethodHandler>> = agentMethodHandlers,
): Promise<AgentResponse> {
  const handler = handlers[request.method];
  if (!handler) {
    return {
      id: request.id,
      error: { code: "unsupported-method", message: `method not supported: ${request.method}` },
    };
  }

  try {
    const result = await handler(rootPath, request.params);
    return { id: request.id, result };
  } catch (error) {
    return { id: request.id, error: errorToFrame(error) };
  }
}

/**
 * Validates the protocol-level request envelope after JSON parsing.
 */
export function parseAgentRequest(value: unknown): AgentRequest {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.method !== "string") {
    throw createProtocolError("request must include string id and method");
  }

  return {
    id: value.id,
    method: value.method,
    params: value.params,
  };
}

/**
 * Creates a protocol-error response for malformed request frames.
 */
export function createProtocolErrorResponse(id: string, message: string): AgentResponse {
  return {
    id,
    error: { code: "agent.protocol-error", message },
  };
}

/**
 * Extracts an id string from a parsed object when request validation fails.
 */
export function idFromParsedFrame(value: unknown): string | null {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }
  return value.id;
}

/**
 * Best-effort id recovery for malformed JSON lines that still contain an id.
 */
export function idFromMalformedLine(line: string): string | null {
  const match = /"id"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/.exec(line);
  if (!match) {
    return null;
  }

  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return null;
  }
}

/**
 * Narrows unknown JSON values to object records.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalizes thrown domain and protocol errors into remote error frames.
 */
function errorToFrame(error: unknown): AgentErrorFrame {
  const code = codeFromError(error);
  const message = error instanceof Error ? error.message : String(error);
  return { code, message };
}

/**
 * Preserves explicit error codes and fs error prefixes for callers.
 */
function codeFromError(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string") {
    return error.code;
  }

  const message = error instanceof Error ? error.message : String(error);
  for (const code of Object.values(FS_ERROR)) {
    if (message.startsWith(`${code}:`)) {
      return code;
    }
  }

  return "agent.request-failed";
}

/**
 * Creates an Error carrying the stable protocol error code.
 */
function createProtocolError(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = "agent.protocol-error";
  return error;
}
