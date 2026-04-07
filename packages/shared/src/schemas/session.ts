import { z } from 'zod'

export const SessionStatusSchema = z.enum([
  'idle',
  'running',
  'waiting_permission',
  'stopping',
  'stopped',
  'error',
])

export const StartSessionRequestSchema = z.object({
  workspacePath: z.string(),
  prompt: z.string(),
  permissionMode: z.enum(['default', 'auto', 'plan', 'bypassPermissions']).optional(),
  model: z.string().optional(),
})

export const SessionResponseSchema = z.object({
  id: z.string(),
  workspacePath: z.string(),
  status: SessionStatusSchema,
  createdAt: z.string().datetime(),
})

export const TextChunkEventSchema = z.object({
  type: z.literal('text_chunk'),
  sessionId: z.string(),
  text: z.string(),
})

export const ToolCallEventSchema = z.object({
  type: z.literal('tool_call'),
  sessionId: z.string(),
  toolName: z.string(),
  toolInput: z.record(z.string(), z.unknown()),
  toolCallId: z.string(),
})

export const ToolResultEventSchema = z.object({
  type: z.literal('tool_result'),
  sessionId: z.string(),
  toolCallId: z.string(),
  result: z.string(),
  isError: z.boolean().optional(),
})

export const PermissionRequestEventSchema = z.object({
  type: z.literal('permission_request'),
  sessionId: z.string(),
  permissionId: z.string(),
  toolName: z.string(),
  toolInput: z.record(z.string(), z.unknown()),
})

export const TurnEndEventSchema = z.object({
  type: z.literal('turn_end'),
  sessionId: z.string(),
})

export const SessionErrorEventSchema = z.object({
  type: z.literal('session_error'),
  sessionId: z.string(),
  message: z.string(),
})

export const SessionEventSchema = z.discriminatedUnion('type', [
  TextChunkEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  PermissionRequestEventSchema,
  TurnEndEventSchema,
  SessionErrorEventSchema,
])

export type SessionStatus = z.infer<typeof SessionStatusSchema>
export type StartSessionRequest = z.infer<typeof StartSessionRequestSchema>
export type SessionResponse = z.infer<typeof SessionResponseSchema>
export type TextChunkEvent = z.infer<typeof TextChunkEventSchema>
export type ToolCallEvent = z.infer<typeof ToolCallEventSchema>
export type ToolResultEvent = z.infer<typeof ToolResultEventSchema>
export type PermissionRequestEvent = z.infer<typeof PermissionRequestEventSchema>
export type TurnEndEvent = z.infer<typeof TurnEndEventSchema>
export type SessionErrorEvent = z.infer<typeof SessionErrorEventSchema>
export type SessionEvent = z.infer<typeof SessionEventSchema>
