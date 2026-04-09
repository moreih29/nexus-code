import type { ToolCallState, PermissionRequestState, PermissionDenyState } from '../adapters/session-adapter.js'

// DisplayMessage covers both MockMessage and ChatMessage shapes
export interface DisplayMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  label?: string
  toolCalls?: ToolCallState[]
  permissionRequest?: PermissionRequestState
  permissionDeny?: PermissionDenyState
  subagentSpawn?: { count: number }
  subagentResult?: { name: string; type: string; summary: string }
  isStreaming?: boolean
}
