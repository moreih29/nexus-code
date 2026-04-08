import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { SessionEvent } from '@nexus/shared'
import { SessionEventSchema } from '@nexus/shared'
import { encodeWorkspacePath } from '../lib/workspace-path'

const BASE_URL = import.meta.env.VITE_API_URL ?? ''

type SseOptions = {
  workspacePath: string
  onEvent?: (event: SessionEvent) => void
  enabled?: boolean
}

export function useSse({ workspacePath, onEvent, enabled = true }: SseOptions): void {
  const queryClient = useQueryClient()
  const esRef = useRef<EventSource | null>(null)
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    if (!enabled) return

    let disposed = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let backoffMs = 2000

    const url = `${BASE_URL}/api/workspaces/${encodeWorkspacePath(workspacePath)}/events`

    const eventTypes = [
      'session_init', 'text_delta', 'tool_call', 'tool_result',
      'permission_request', 'permission_settled', 'turn_end', 'error', 'rate_limit', 'hook_event',
    ]

    function handleSseEvent(e: MessageEvent) {
      const eventName = (e as Event).type

      if (eventName === 'session_init' || eventName === 'rate_limit' || eventName === 'hook_event') {
        return
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(e.data as string)
      } catch {
        return
      }

      console.log('[sse]', eventName, parsed)

      const mappedType = eventName === 'text_delta' ? 'text_chunk'
        : eventName === 'error' ? 'session_error'
        : eventName
      const withType = typeof parsed === 'object' && parsed !== null
        ? { type: mappedType, ...parsed as Record<string, unknown> }
        : parsed

      const result = SessionEventSchema.safeParse(withType)
      if (!result.success) {
        console.log('[sse] schema validation failed', eventName, withType, result.error)
        return
      }

      const event = result.data
      onEventRef.current?.(event)

      if (event.type === 'turn_end' && event.sessionId) {
        void queryClient.invalidateQueries({ queryKey: ['sessions', event.sessionId, 'status'] })
      }
    }

    function connect() {
      if (disposed) return

      const es = new EventSource(url)
      esRef.current = es

      es.onopen = () => {
        console.log('[sse] connected')
      }

      for (const type of eventTypes) {
        es.addEventListener(type, handleSseEvent)
      }
      es.onmessage = handleSseEvent

      es.onerror = () => {
        es.close()
        esRef.current = null
        if (!disposed) {
          console.log(`[sse] disconnected, reconnecting in ${backoffMs / 1000}s...`)
          reconnectTimer = setTimeout(connect, backoffMs)
          backoffMs = Math.min(backoffMs * 2, 60000) // exponential backoff, max 60s
        }
      }

      es.onopen = () => {
        backoffMs = 2000 // reset on successful connection
      }
    }

    connect()

    return () => {
      disposed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      esRef.current?.close()
      esRef.current = null
    }
  }, [workspacePath, enabled, queryClient])
}
