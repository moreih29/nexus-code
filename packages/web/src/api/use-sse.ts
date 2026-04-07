import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { SessionEvent } from '@nexus/shared'
import { SessionEventSchema } from '@nexus/shared'

const BASE_URL = import.meta.env.VITE_API_URL ?? ''

type SseOptions = {
  workspacePath: string
  onEvent?: (event: SessionEvent) => void
  enabled?: boolean
}

export function useSse({ workspacePath, onEvent, enabled = true }: SseOptions): void {
  const queryClient = useQueryClient()
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (!enabled) return

    const url = `${BASE_URL}/api/events/${encodeURIComponent(workspacePath)}`
    const es = new EventSource(url)
    esRef.current = es

    es.onmessage = (e: MessageEvent) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(e.data as string)
      } catch {
        return
      }

      const result = SessionEventSchema.safeParse(parsed)
      if (!result.success) return

      const event = result.data
      onEvent?.(event)

      if (event.type === 'turn_end') {
        void queryClient.invalidateQueries({ queryKey: ['sessions', event.sessionId, 'status'] })
      }
    }

    es.onerror = () => {
      es.close()
      esRef.current = null
    }

    return () => {
      es.close()
      esRef.current = null
    }
  }, [workspacePath, enabled, onEvent, queryClient])
}
