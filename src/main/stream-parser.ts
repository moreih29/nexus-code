import { EventEmitter } from 'events'
import type {
  TextChunkEvent,
  ToolCallEvent,
  ToolResultEvent,
  PermissionRequestEvent,
  SessionEndEvent,
  ErrorEvent,
} from '../shared/types'

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

interface ResultMessage {
  type: 'result'
  session_id?: string
  result?: string
  is_error?: boolean
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
  on(event: 'error', listener: (data: Omit<ErrorEvent, 'sessionId'>) => void): this
  on(event: 'session_id', listener: (sessionId: string) => void): this
}

export class StreamParser extends EventEmitter {
  private buffer: string = ''

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
  }

  private parseLine(line: string): void {
    let msg: ClaudeStreamMessage
    try {
      msg = JSON.parse(line)
    } catch {
      this.emit('error', { message: `JSON 파싱 실패: ${line.slice(0, 120)}` })
      return
    }

    try {
      console.log('[StreamParser]', msg.type, (msg as Record<string, unknown>).subtype ?? '')
      this.handleMessage(msg)
    } catch (err) {
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
        // stream_event에서 이미 실시간 텍스트를 받았으므로 text는 무시
        // tool_use만 처리
        const m = msg as unknown as AssistantMessage
        const content = m.message?.content ?? []
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

      case 'result': {
        const m = msg as unknown as ResultMessage
        this.emit('session_end', { exitCode: m.is_error ? 1 : 0 })
        break
      }

      case 'stream_event': {
        // stream-json 실시간 이벤트: { type: "stream_event", event: { type: "content_block_delta", delta: { text: "..." } } }
        const inner = (msg as Record<string, unknown>).event as Record<string, unknown> | undefined
        if (!inner) break

        if (inner.type === 'content_block_delta') {
          const delta = inner.delta as Record<string, unknown> | undefined
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            this.emit('text_chunk', { text: delta.text })
          }
        }
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
        break
    }
  }
}
