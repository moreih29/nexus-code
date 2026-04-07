import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { StartSessionRequest } from '@nexus/shared'
import { startSession, sendPrompt, cancelSession, fetchSessionStatus } from '../api/session'

export function useStartSession() {
  return useMutation({
    mutationFn: (body: StartSessionRequest) => startSession(body),
  })
}

export function useSendPrompt(sessionId: string) {
  return useMutation({
    mutationFn: (prompt: string) => sendPrompt(sessionId, prompt),
  })
}

export function useCancelSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (sessionId: string) => cancelSession(sessionId),
    onSuccess: (_data, sessionId) => {
      void queryClient.invalidateQueries({ queryKey: ['sessions', sessionId, 'status'] })
    },
  })
}

export function useSessionStatus(sessionId: string, enabled = true) {
  return useQuery({
    queryKey: ['sessions', sessionId, 'status'],
    queryFn: () => fetchSessionStatus(sessionId),
    enabled,
    refetchInterval: 3000,
  })
}
