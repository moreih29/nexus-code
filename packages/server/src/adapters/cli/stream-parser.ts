type Handler<T> = (data: T) => void

export interface StreamEventPayload {
  type: string
  event: {
    type: string
    index?: number
    delta?: {
      type: string
      text?: string
    }
  }
  session_id?: string
  parent_tool_use_id?: string | null
  uuid?: string
}

export interface InitPayload {
  sessionId: string
  model?: string
  permissionMode?: string
  tools?: unknown[]
}

export interface TurnEndPayload {
  totalCostUsd?: number
  usage?: Record<string, unknown>
  modelUsage?: Record<string, unknown>
}

export interface StreamParserEvents {
  /** @deprecated use 'init' — kept for backward compatibility */
  session_id: { sessionId: string }
  init: InitPayload
  text_chunk: { text: string }
  text_delta: { text: string }
  stream_event: StreamEventPayload
  tool_call: { toolCallId: string; toolName: string; toolInput: Record<string, unknown> | string }
  tool_result: { toolCallId: string; result: string; isError?: boolean }
  permission_request: { permissionId: string; toolName: string; toolInput: Record<string, unknown> }
  turn_end: TurnEndPayload
  error: { message: string; raw?: string }
  rate_limit: { message: string }
  rate_limit_info: { status: string; resetsAt?: number; [key: string]: unknown }
  hook_event: { subtype: string; [key: string]: unknown }
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

    if (type === 'system') {
      const subtype = msg['subtype']

      if (subtype === 'init') {
        const sessionId = msg['session_id']
        if (typeof sessionId === 'string') {
          // backward compat
          this._emit('session_id', { sessionId })

          const initPayload: InitPayload = { sessionId }
          if (typeof msg['model'] === 'string') {
            initPayload.model = msg['model']
          }
          if (typeof msg['permissionMode'] === 'string') {
            initPayload.permissionMode = msg['permissionMode']
          }
          if (Array.isArray(msg['tools'])) {
            initPayload.tools = msg['tools'] as unknown[]
          }
          this._emit('init', initPayload)
        }
        return
      }

      if (
        subtype === 'hook_started' ||
        subtype === 'hook_response' ||
        subtype === 'hook_progress'
      ) {
        this._emit('hook_event', { ...msg, subtype: String(subtype) })
        return
      }

      return
    }

    if (type === 'stream_event') {
      const event = msg['event']
      if (isObject(event)) {
        const payload = msg as unknown as StreamEventPayload
        this._emit('stream_event', payload)

        if (
          isObject(event) &&
          event['type'] === 'content_block_delta' &&
          isObject(event['delta']) &&
          (event['delta'] as Record<string, unknown>)['type'] === 'text_delta'
        ) {
          const text = (event['delta'] as Record<string, unknown>)['text']
          if (typeof text === 'string') {
            this._emit('text_delta', { text })
          }
        }
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
          if (typeof id === 'string' && typeof name === 'string') {
            const toolInput: Record<string, unknown> | string = isObject(input)
              ? (input as Record<string, unknown>)
              : typeof input === 'string'
                ? input
                : {}
            this._emit('tool_call', {
              toolCallId: id,
              toolName: name,
              toolInput,
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
        const payload: TurnEndPayload = {}
        const cost = msg['total_cost_usd']
        if (typeof cost === 'number') {
          payload.totalCostUsd = cost
        }
        if (isObject(msg['usage'])) {
          payload.usage = msg['usage'] as Record<string, unknown>
        }
        if (isObject(msg['modelUsage'])) {
          payload.modelUsage = msg['modelUsage'] as Record<string, unknown>
        }
        this._emit('turn_end', payload)
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

    if (type === 'rate_limit_event') {
      const rateLimitInfo = msg['rate_limit_info']
      if (isObject(rateLimitInfo)) {
        this._emit('rate_limit_info', rateLimitInfo as { status: string; resetsAt?: number })
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
