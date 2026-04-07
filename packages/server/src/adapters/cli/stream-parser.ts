type Handler<T> = (data: T) => void

export interface StreamParserEvents {
  session_id: { sessionId: string }
  text_chunk: { text: string }
  tool_call: { toolCallId: string; toolName: string; toolInput: Record<string, unknown> }
  tool_result: { toolCallId: string; result: string; isError?: boolean }
  permission_request: { permissionId: string; toolName: string; toolInput: Record<string, unknown> }
  turn_end: Record<string, never>
  error: { message: string; raw?: string }
  rate_limit: { message: string }
}

type EventName = keyof StreamParserEvents

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ListenerMap = Map<EventName, Set<Handler<any>>>

export class StreamParser {
  private readonly _listeners: ListenerMap = new Map()
  private _disposed = false

  on<E extends EventName>(event: E, handler: Handler<StreamParserEvents[E]>): () => void {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set())
    }
    this._listeners.get(event)!.add(handler)
    return () => {
      this._listeners.get(event)?.delete(handler)
    }
  }

  feed(line: string): void {
    if (this._disposed) return
    const trimmed = line.trim()
    if (!trimmed) return

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      this._emit('error', { message: 'Invalid JSON', raw: trimmed })
      return
    }

    this._dispatch(parsed)
  }

  dispose(): void {
    this._disposed = true
    this._listeners.clear()
  }

  private _emit<E extends EventName>(event: E, data: StreamParserEvents[E]): void {
    const handlers = this._listeners.get(event)
    if (!handlers) return
    for (const h of handlers) {
      h(data)
    }
  }

  private _dispatch(msg: unknown): void {
    if (!isObject(msg)) {
      this._emit('error', { message: 'Expected JSON object', raw: JSON.stringify(msg) })
      return
    }

    const type = msg['type']

    if (type === 'system' && msg['subtype'] === 'init') {
      const sessionId = msg['session_id']
      if (typeof sessionId === 'string') {
        this._emit('session_id', { sessionId })
      }
      return
    }

    if (type === 'assistant') {
      const message = msg['message']
      if (!isObject(message)) return
      const content = message['content']
      if (!Array.isArray(content)) return

      for (const block of content) {
        if (!isObject(block)) continue
        const blockType = block['type']

        if (blockType === 'text') {
          const text = block['text']
          if (typeof text === 'string') {
            this._emit('text_chunk', { text })
          }
        } else if (blockType === 'tool_use') {
          const id = block['id']
          const name = block['name']
          const input = block['input']
          if (typeof id === 'string' && typeof name === 'string' && isObject(input)) {
            this._emit('tool_call', {
              toolCallId: id,
              toolName: name,
              toolInput: input as Record<string, unknown>,
            })
          }
        } else if (blockType === 'tool_result') {
          const toolUseId = block['tool_use_id']
          const blockContent = block['content']
          const isError = block['is_error']
          if (typeof toolUseId === 'string') {
            const result =
              typeof blockContent === 'string'
                ? blockContent
                : Array.isArray(blockContent)
                  ? blockContent
                      .filter(isObject)
                      .map((b) => (b['type'] === 'text' ? String(b['text'] ?? '') : ''))
                      .join('')
                  : ''
            this._emit('tool_result', {
              toolCallId: toolUseId,
              result,
              isError: isError === true ? true : undefined,
            })
          }
        }
      }
      return
    }

    if (type === 'result') {
      const subtype = msg['subtype']
      if (subtype === 'success' || subtype === 'error_max_turns' || subtype === 'error_during_execution') {
        this._emit('turn_end', {})
      }
      if (subtype === 'error_max_turns' || subtype === 'error_during_execution') {
        const errorMsg = typeof msg['error'] === 'string' ? msg['error'] : String(subtype)
        this._emit('error', { message: errorMsg })
      }
      return
    }

    if (type === 'permission_request') {
      const permissionId = msg['permission_id']
      const toolName = msg['tool_name']
      const toolInput = msg['tool_input']
      if (
        typeof permissionId === 'string' &&
        typeof toolName === 'string' &&
        isObject(toolInput)
      ) {
        this._emit('permission_request', {
          permissionId,
          toolName,
          toolInput: toolInput as Record<string, unknown>,
        })
      }
      return
    }

    if (type === 'rate_limit_error') {
      const message = typeof msg['message'] === 'string' ? msg['message'] : 'Rate limited'
      this._emit('rate_limit', { message })
      return
    }
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
