// Validation/parsing layer for the agent ↔ host wire payloads. The host
// class only handles routing decisions; this module owns the schemas
// that turn raw `unknown` channel events into typed objects (or null
// when the payload does not match).

import { z } from "zod";
import {
  type ServerCapabilities,
  ServerCapabilitiesSchema,
  ShowMessageRequestParamsSchema,
  WorkDoneProgressCreateParamsSchema,
} from "../../../shared/lsp";
import { asRecord } from "./lsp-utils";

interface AgentSpawnResultShape {
  serverId: string;
  capabilities?: unknown;
}

const SpawnResultSchema = z.object({
  serverId: z.string().min(1),
  capabilities: z.unknown().optional(),
});

export function parseSpawnResult(result: unknown): AgentSpawnResultShape {
  return SpawnResultSchema.parse(result);
}

export function parseServerCapabilities(capabilities: unknown): ServerCapabilities {
  const parsed = ServerCapabilitiesSchema.safeParse(capabilities);
  return parsed.success ? parsed.data : {};
}

export function parseAgentMessagePayload(
  payload: unknown,
): { serverId: string; message: unknown } | null {
  const record = asRecord(payload);
  if (!record || typeof record.serverId !== "string" || !("message" in record)) {
    return null;
  }
  return { serverId: record.serverId, message: record.message };
}

export function parseAgentServerRequestPayload(
  payload: unknown,
): { serverId: string; agentRequestId: string; method: string; params: unknown } | null {
  const parsed = z
    .object({
      serverId: z.string(),
      agentRequestId: z.string(),
      method: z.string(),
      params: z.unknown().optional(),
    })
    .safeParse(payload);
  return parsed.success
    ? { ...parsed.data, params: parsed.data.params === undefined ? null : parsed.data.params }
    : null;
}

export function parseServerAssignedPayload(
  payload: unknown,
): { serverId: string; correlationId: string } | null {
  const parsed = z
    .object({
      serverId: z.string().min(1),
      correlationId: z.string().min(1).optional(),
    })
    .safeParse(payload);
  if (!parsed.success) return null;
  return { serverId: parsed.data.serverId, correlationId: parsed.data.correlationId ?? "" };
}

export function parseServerExitedPayload(
  payload: unknown,
): { serverId: string; reason: string; stderrTail: string } | null {
  const parsed = z
    .object({
      serverId: z.string().min(1),
      reason: z.string().optional(),
      stderrTail: z.string().optional(),
    })
    .safeParse(payload);
  if (!parsed.success) return null;
  return {
    serverId: parsed.data.serverId,
    reason: parsed.data.reason ?? "",
    stderrTail: parsed.data.stderrTail ?? "",
  };
}

export function firstShowMessageAction(params: unknown): unknown {
  const parsed = ShowMessageRequestParamsSchema.safeParse(params);
  if (!parsed.success) return null;
  return parsed.data.actions?.[0] ?? null;
}

export function parseWorkDoneProgressCreateParams(params: unknown): unknown {
  const parsed = WorkDoneProgressCreateParamsSchema.safeParse(params);
  return parsed.success ? parsed.data : params;
}

// serverExitError shapes the server-exited payload into an Error with the
// stderr tail appended. Used by the host to fail in-flight requests when
// the LSP process dies while requests are still pending.
export function serverExitError(payload: { reason: string; stderrTail: string }): Error {
  const reason = payload.reason || "lsp server exited";
  const tail = payload.stderrTail.trim();
  return new Error(tail ? `${reason}\n${tail}` : reason);
}
