import { z } from 'zod'

export const ApprovalScopeSchema = z.enum(['session', 'permanent'])

export const ApprovalRequestSchema = z.object({
  permissionId: z.string(),
  sessionId: z.string(),
  toolName: z.string(),
  toolInput: z.record(z.string(), z.unknown()),
})

export const ApprovalResponseSchema = z.object({
  permissionId: z.string(),
  approved: z.boolean(),
  scope: ApprovalScopeSchema.optional(),
})

export type ApprovalScope = z.infer<typeof ApprovalScopeSchema>
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>
export type ApprovalResponse = z.infer<typeof ApprovalResponseSchema>
