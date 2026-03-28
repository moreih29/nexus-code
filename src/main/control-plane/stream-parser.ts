import { EventEmitter } from 'events'
import log from '../logger'
import type {
  TextChunkEvent,
  ToolCallEvent,
  ToolResultEvent,
  PermissionRequestEvent,
  SessionEndEvent,
  TurnEndEvent,
  ErrorEvent,
  RateLimitEvent,
} from '../../shared/types'

// Claude CLI stream-json 출력의 메시지 타입
interface ClaudeStreamMessage {
  type: string
  [key: string]: unknown
}

interface AssistantMessage {
  type: 'assistant'
  message?: {
    content?: Array<{
      type: string
      text?: string
      id?: string
      name?: string
      input?: Record<string, unknown>
    }>
  }
}

interface ToolResultMessage {
  type: 'tool_result'
  tool_use_id?: string
  content?: string | Array<{ type: string; text?: string }>
  is_error?: boolean
}

interface UserMessage {
  type: 'user'
  message?: {
    role?: string
    content?: Array<{
      type: string
      tool_use_id?: string
      content?: string | Array<{ type: string; text?: string }>
      is_error?: boolean
    }>
  }
}

interface SystemMessage {
  type: 'system'
  subtype?: string
  session_id?: string
}

export declare interface StreamParser {
  on(event: 'text_chunk', listener: (data: Omit<TextChunkEvent, 'sessionId'>) => void): this
  on(event: 'tool_call', listener: (data: Omit<ToolCallEvent, 'sessionId'>) => void): this
  on(event: 'tool_result', listener: (data: Omit<ToolResultEvent, 'sessionId'>) => void): this
  on(
    event: 'permission_request',
    listener: (data: Omit<PermissionRequestEvent, 'sessionId'>) => void
  ): this
  on(event: 'session_end', listener: (data: Omit<SessionEndEvent, 'sessionId'>) => void): this
  on(event: 'turn_end', listener: (data: Omit<TurnEndEvent, 'sessionId'>) => void): this
  on(event: 'error', listener: (data: Omit<ErrorEvent, 'sessionId'>) => void): this
  on(event: 'session_id', listener: (sessionId: string) => void): this
  on(event: 'rate_limit', listener: (data: Omit<RateLimitEvent, 'sessionId'>) => void): this
}

export class StreamParser extends EventEmitter {
  private buffer: string = ''
  private streamedTextLength = 0

  feed(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    // 마지막 요소는 불완전한 라인일 수 있으므로 버퍼에 보존
    this.buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      this.parseLine(trimmed)
    }
  }

  flush(): void {
    const trimmed = this.buffer.trim()
    if (trimmed.length > 0) {
      this.parseLine(trimmed)
    }
    this.buffer = ''
    this.streamedTextLength = 0
  }

  private parseLine(line: string): void {
    let msg: ClaudeStreamMessage
    try {
      msg = JSON.parse(line)
    } catch {
      log.warn('[StreamParser] JSON parse failed:', line.slice(0, 120))
      this.emit('error', { message: `JSON 파싱 실패: ${line.slice(0, 120)}` })
      return
    }

    try {
      log.debug('[StreamParser]', msg.type, (msg as Record<string, unknown>).subtype ?? '')
      this.handleMessage(msg)
    } catch (err) {
      log.error('[StreamParser] handle error:', String(err))
      this.emit('error', { message: `메시지 처리 오류: ${String(err)}` })
    }
  }

  private handleMessage(msg: ClaudeStreamMessage): void {
    switch (msg.type) {
      case 'system': {
        const m = msg as unknown as SystemMessage
        if (m.subtype === 'init' && m.session_id) {
          this.emit('session_id', m.session_id)
        }
        break
      }

      case 'assistant': {
        const m = msg as unknown as AssistantMessage
        const content = m.message?.content ?? []

        // stream_event로 텍스트가 이미 전달되지 않은 경우에만 fallback emit (비스트리밍 응답 대비)
        if (this.streamedTextLength === 0) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              this.emit('text_chunk', { text: block.text })
            }
          }
        }
        this.streamedTextLength = 0  // 다음 턴을 위해 리셋

        // tool_use 처리
        for (const block of content) {
          if (block.type === 'tool_use') {
            this.emit('tool_call', {
              toolUseId: block.id ?? '',
              name: block.name ?? '',
              input: block.input ?? {},
            })
          }
        }
        break
      }

      case 'tool_result': {
        const m = msg as unknown as ToolResultMessage
        let content = ''
        if (typeof m.content === 'string') {
          content = m.content
        } else if (Array.isArray(m.content)) {
          content = m.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('')
        }
        this.emit('tool_result', {
          toolUseId: m.tool_use_id ?? '',
          content,
          isError: m.is_error,
        })
        break
      }

      case 'user': {
        // CLI stream-json에서 tool_result는 type:"user" 메시지의 content 배열에 포함됨
        const m = msg as unknown as UserMessage
        const blocks = m.message?.content ?? []
        for (const block of blocks) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            let content = ''
            if (typeof block.content === 'string') {
              content = block.content
            } else if (Array.isArray(block.content)) {
              content = block.content
                .filter((b) => b.type === 'text')
                .map((b) => b.text ?? '')
                .join('')
            }
            this.emit('tool_result', {
              toolUseId: block.tool_use_id,
              content,
              isError: block.is_error,
            })
          }
        }
        break
      }

      case 'result': {
        const r = msg as Record<string, unknown>
        const costUsd = typeof r.total_cost_usd === 'number' ? r.total_cost_usd as number : undefined
        const durationMs = typeof r.duration_ms === 'number' ? r.duration_ms as number : undefined
        const durationApiMs = typeof r.duration_api_ms === 'number' ? r.duration_api_ms as number : undefined
        const numTurns = typeof r.num_turns === 'number' ? r.num_turns as number : undefined
        const usage = r.usage as Record<string, unknown> | undefined
        const inputTokens = typeof usage?.input_tokens === 'number' ? usage.input_tokens as number : undefined
        const outputTokens = typeof usage?.output_tokens === 'number' ? usage.output_tokens as number : undefined
        this.emit('turn_end', { costUsd, durationMs, durationApiMs, numTurns, inputTokens, outputTokens })
        break
      }

      case 'stream_event': {
        // stream-json 실시간 이벤트: { type: "stream_event", event: { type: "content_block_delta", delta: { text: "..." } } }
        const inner = (msg as Record<string, unknown>).event as Record<string, unknown> | undefined
        if (!inner) break

        if (inner.type === 'content_block_delta') {
          const delta = inner.delta as Record<string, unknown> | undefined
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            this.streamedTextLength += delta.text.length
            this.emit('text_chunk', { text: delta.text })
          }
        }
        break
      }

      case 'rate_limit_event': {
        const retryAfterMs = typeof (msg as Record<string, unknown>).retry_after_ms === 'number'
          ? (msg as Record<string, unknown>).retry_after_ms as number
          : undefined
        log.debug('[StreamParser] rate_limit_event, retryAfterMs:', retryAfterMs)
        this.emit('rate_limit', { retryAfterMs })
        break
      }

      // 최상위에 직접 오는 경우 (fallback)
      case 'content_block_start':
      case 'content_block_delta':
      case 'content_block_stop':
      case 'message_start':
      case 'message_delta':
      case 'message_stop':
        break

      default:
        log.debug('[StreamParser] unhandled message type:', msg.type,
          (msg as Record<string, unknown>).subtype ?? '')
        break
    }
  }
}
