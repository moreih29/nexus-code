import { apiClient } from './client'

export interface ApprovalResponse {
  id: string
  decision: 'allow' | 'deny'
  scope: 'once' | 'session' | 'permanent'
}

export interface PendingApproval {
  id: string
  toolName: string
  toolInput: Record<string, unknown>
}

export function respondApproval(
  id: string,
  decision: 'allow' | 'deny',
  scope?: 'once' | 'session' | 'permanent',
): Promise<ApprovalResponse> {
  return apiClient.post<ApprovalResponse>(`/api/approvals/${id}/respond`, { decision, scope })
}

export function fetchPendingApprovals(): Promise<{ approvals: PendingApproval[] }> {
  return apiClient.get<{ approvals: PendingApproval[] }>('/api/approvals')
}
