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

    // workspacePath는 절대경로 (/Users/...) — 서버가 /:path{.+}로 받으므로 선행 / 제거
    const pathParam = workspacePath.startsWith('/') ? workspacePath.slice(1) : workspacePath
    const url = `${BASE_URL}/api/workspaces/${pathParam}/events`
    const es = new EventSource(url)
    esRef.current = es

    console.log('[sse] connecting to', url)

    es.onopen = () => {
      console.log('[sse] connected')
    }

    // 서버가 named events (event: 'text_chunk' 등)로 보내므로 각 이벤트 타입별 리스너 등록
    // text_delta(증분)만 사용, text_chunk(누적)는 무시 — 둘 다 수신하면 중복
    const eventTypes = [
      'session_init', 'text_delta', 'tool_call', 'tool_result',
      'permission_request', 'turn_end', 'error', 'rate_limit', 'hook_event',
    ]

    function handleSseEvent(e: MessageEvent) {
      const eventName = (e as Event).type

      // 무시할 이벤트
      if (eventName === 'session_init' || eventName === 'rate_limit' || eventName === 'hook_event') {
        return
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(e.data as string)
      } catch {
        return
      }

      // text_delta → text_chunk로 매핑 (어댑터가 text_chunk 타입을 기대)
      const mappedType = eventName === 'text_delta' ? 'text_chunk' : eventName
      const withType = typeof parsed === 'object' && parsed !== null
        ? { type: mappedType, ...parsed as Record<string, unknown> }
        : parsed

      const result = SessionEventSchema.safeParse(withType)
      if (!result.success) {
        console.log('[sse] schema validation failed', eventName, withType, result.error)
        return
      }

      const event = result.data
      console.log('[sse] event', event.type)
      onEvent?.(event)

      if (event.type === 'turn_end') {
        void queryClient.invalidateQueries({ queryKey: ['sessions', event.sessionId, 'status'] })
      }
    }

    for (const type of eventTypes) {
      es.addEventListener(type, handleSseEvent)
    }

    // fallback: unnamed events도 처리
    es.onmessage = handleSseEvent

    es.onerror = (err) => {
      console.log('[sse] error, closing', err)
      es.close()
      esRef.current = null
    }

    return () => {
      es.close()
      esRef.current = null
    }
  }, [workspacePath, enabled, onEvent, queryClient])
}
