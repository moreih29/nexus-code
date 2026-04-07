import { useMutation } from '@tanstack/react-query'
import { respondApproval } from '../api/approval'

interface RespondApprovalVariables {
  id: string
  decision: 'allow' | 'deny'
  scope?: 'once' | 'session' | 'permanent'
}

export function useRespondApproval() {
  return useMutation({
    mutationFn: ({ id, decision, scope }: RespondApprovalVariables) =>
      respondApproval(id, decision, scope),
  })
}
