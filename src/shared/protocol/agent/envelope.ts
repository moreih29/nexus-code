import { z } from "zod";

/**
 * NDJSON wire format for the Electron main ↔ agent child channel.
 *
 * One JSON object per line. Three frame kinds share the channel:
 *   - Request: client → server, expects a matching Response
 *   - Response: server → client, correlated by `id`
 *   - Event: server → client broadcast, no `id` (e.g. fs.changed; Round 3)
 * Plus a one-shot Ready frame the server emits on startup to advertise
 * its protocol version.
 *
 * These schemas mirror `internal/proto/proto.go`. When changing one
 * side, change both — round-trip tests catch drift but the names should
 * also stay aligned.
 */

export const AGENT_PROTOCOL_VERSION = "1";

/** Request frame. `params` is method-specific and validated separately. */
export const AgentRequestSchema = z.object({
  id: z.string(),
  method: z.string(),
  params: z.unknown().optional(),
});
export type AgentRequest = z.infer<typeof AgentRequestSchema>;

/** Error frame carried inside a failed Response. */
export const AgentErrorFrameSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type AgentErrorFrame = z.infer<typeof AgentErrorFrameSchema>;

/**
 * Response frame. Exactly one of `result` or `error` is present on the
 * wire — the Go side uses `omitempty`, so absent fields do not appear.
 * Both are modeled as optional rather than a discriminated union so that
 * a void-result response (`{"id":"x"}`, no `result` key) parses cleanly.
 * Callers must branch on `response.error`: when present, the call failed;
 * otherwise the call succeeded and `response.result` carries the payload
 * (which may itself be `undefined` for void-returning methods).
 */
export const AgentResponseSchema = z.object({
  id: z.string(),
  result: z.unknown().optional(),
  error: AgentErrorFrameSchema.optional(),
});
export type AgentResponse = z.infer<typeof AgentResponseSchema>;

/**
 * Broadcast frame, server → client only. No `id` — events do not correlate
 * to a pending request. Reserved for Round 3 (fs.changed, search progress).
 */
export const AgentEventSchema = z.object({
  event: z.string(),
  payload: z.unknown().optional(),
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;

/**
 * Boot handshake frame emitted on stdout immediately after the server
 * process starts. The client uses it to verify that the binary matches
 * the expected protocol version before issuing any request.
 */
export const AgentReadyFrameSchema = z.object({
  type: z.literal("ready"),
  protocolVersion: z.string(),
  serverVersion: z.string(),
});
export type AgentReadyFrame = z.infer<typeof AgentReadyFrameSchema>;
