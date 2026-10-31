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
import { asRecord } from "./utils";

interface AgentSpawnResultShape {
  serverId: string;
  capabilities?: unknown;
  serverInfo?: { name: string; version?: string };
}

/**
 * The version a server reports, as a person reads it. gopls reports its
 * whole build info as JSON, with the version inside.
 */
function readableServerVersion(version: string | undefined): string | undefined {
  if (!version?.startsWith("{")) return version;
  try {
    const info = JSON.parse(version) as { Version?: unknown; Main?: { Version?: unknown } };
    const found = info.Version ?? info.Main?.Version;
    return typeof found === "string" ? found : undefined;
  } catch {
    return undefined;
  }
}

const SpawnResultSchema = z.object({
  serverId: z.string().min(1),
  capabilities: z.unknown().optional(),
  // A server's own words: dropped rather than failing the spawn when odd.
  serverInfo: z
    .object({ name: z.string(), version: z.string().optional().transform(readableServerVersion) })
    .optional()
    .catch(undefined),
});

export function parseSpawnResult(result: unknown): AgentSpawnResultShape {
  return SpawnResultSchema.parse(result);
}

const FindBinaryResultSchema = z.object({
  path: z.string(),
  envPath: z.string().optional(),
});

/** lsp.findBinary: the server found on the agent's host, `path` empty when none was. */
export function parseFindBinaryResult(result: unknown): { path: string; envPath?: string } {
  return FindBinaryResultSchema.parse(result);
}

const StatsResultSchema = z.object({
  servers: z.array(z.object({ serverId: z.string(), rssBytes: z.number() })),
});

/** lsp.stats: each server's memory, with the processes it started. */
export function parseStatsResult(result: unknown): Array<{ serverId: string; rssBytes: number }> {
  return StatsResultSchema.parse(result).servers;
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
): { serverId: string; reason: string; stderrTail: string; shutdown: boolean } | null {
  const parsed = z
    .object({
      serverId: z.string().min(1),
      reason: z.string().optional(),
      stderrTail: z.string().optional(),
      // The agent stopped the server: idle, or asked to.
      shutdown: z.boolean().optional(),
    })
    .safeParse(payload);
  if (!parsed.success) return null;
  return {
    serverId: parsed.data.serverId,
    reason: parsed.data.reason ?? "",
    stderrTail: parsed.data.stderrTail ?? "",
    shutdown: parsed.data.shutdown === true,
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
