import { z } from "zod";

export const AGENT_PROTOCOL_VERSION = "2";

export const AgentRequestSchema = z.object({
  id: z.string(),
  method: z.string(),
  params: z.unknown().optional(),
});
export type AgentRequest = z.infer<typeof AgentRequestSchema>;

export const AgentErrorFrameSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type AgentErrorFrame = z.infer<typeof AgentErrorFrameSchema>;

export const AgentResponseSchema = z.object({
  id: z.string(),
  result: z.unknown().optional(),
  error: AgentErrorFrameSchema.optional(),
});
export type AgentResponse = z.infer<typeof AgentResponseSchema>;

export const AgentEventSchema = z.object({
  event: z.string(),
  payload: z.unknown().optional(),
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export const AgentReadyFrameSchema = z.object({
  type: z.literal("ready"),
  protocolVersion: z.string(),
  serverVersion: z.string(),
});
export type AgentReadyFrame = z.infer<typeof AgentReadyFrameSchema>;
