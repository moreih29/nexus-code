export type { AppError } from './errors.js'
export { appError } from './errors.js'

export type { Result } from './result.js'
export { ok, err } from './result.js'

export type {
  Workspace,
  CreateWorkspaceRequest,
  WorkspaceResponse,
} from './schemas/workspace.js'
export {
  WorkspaceSchema,
  CreateWorkspaceRequestSchema,
  WorkspaceResponseSchema,
} from './schemas/workspace.js'

export type {
  PromptBody,
  SessionStatus,
  StartSessionRequest,
  SessionResponse,
  TextChunkEvent,
  ToolCallEvent,
  ToolResultEvent,
  PermissionRequestEvent,
  PermissionSettledEvent,
  TurnEndEvent,
  SessionErrorEvent,
  SessionEvent,
} from './schemas/session.js'
export {
  PromptBodySchema,
  SessionStatusSchema,
  StartSessionRequestSchema,
  SessionResponseSchema,
  TextChunkEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  PermissionRequestEventSchema,
  PermissionSettledEventSchema,
  TurnEndEventSchema,
  SessionErrorEventSchema,
  SessionEventSchema,
} from './schemas/session.js'

export type {
  ApprovalScope,
  ApprovalRequest,
  ApprovalResponse,
} from './schemas/approval.js'
export {
  ApprovalScopeSchema,
  ApprovalRequestSchema,
  ApprovalResponseSchema,
} from './schemas/approval.js'
