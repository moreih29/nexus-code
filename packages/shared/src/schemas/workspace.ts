import { z } from 'zod'

export const WorkspaceSchema = z.object({
  path: z.string(),
  name: z.string().optional(),
})

export const CreateWorkspaceRequestSchema = z.object({
  path: z.string(),
  name: z.string().optional(),
})

export const WorkspaceResponseSchema = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string().optional(),
  createdAt: z.string().datetime(),
})

export type Workspace = z.infer<typeof WorkspaceSchema>
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>
export type WorkspaceResponse = z.infer<typeof WorkspaceResponseSchema>
