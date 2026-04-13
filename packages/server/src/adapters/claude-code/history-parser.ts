import { createReadStream, realpathSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { ok, err, appError } from '@nexus/shared'
import type { Result } from '@nexus/shared'

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown> | string
}

export type AssistantContentBlock = TextBlock | ToolUseBlock

export interface UserContent {
  kind: 'user'
  text: string
}

export interface AssistantContent {
  kind: 'assistant'
  blocks: AssistantContentBlock[]
}

export interface ToolResultContent {
  kind: 'tool_result'
  toolUseId: string
  output: string
  isError?: boolean
}

export type MessageContent = UserContent | AssistantContent | ToolResultContent

export interface HistoryMessage {
  type: 'user' | 'assistant' | 'tool_result'
  uuid: string
  parentUuid: string | null
  timestamp: string
  content: MessageContent
  isSidechain: boolean
}

export function getSessionFilePath(workspacePath: string, cliSessionId: string): string {
  let resolvedPath = workspacePath
  try {
    resolvedPath = realpathSync(workspacePath)
  } catch {
    // Fall back to original path if realpath fails
  }
  const encodedPath = resolvedPath.replace(/\//g, '-')
  return `${process.env['HOME'] ?? '~'}/.claude/projects/${encodedPath}/${cliSessionId}.jsonl`
}

export async function parseSessionHistory(
  filePath: string,
  options?: { offset?: number; limit?: number },
): Promise<Result<HistoryMessage[]>> {
  try {
    await access(filePath)
  } catch {
    return err(appError('HISTORY_FILE_NOT_FOUND', `History file not found: ${filePath}`))
  }

  const offset = options?.offset ?? 0
  const limit = options?.limit ?? 50

  const messages: HistoryMessage[] = []
  let index = 0

  return new Promise((resolve) => {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })

    rl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return

      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        return
      }

      if (!isObject(parsed)) return

      const type = parsed['type']
      if (type !== 'user' && type !== 'assistant' && type !== 'tool_result') return

      const uuid = parsed['uuid']
      const timestamp = parsed['timestamp']
      const isSidechain = parsed['isSidechain']
      const parentUuid = parsed['parentUuid']

      if (typeof uuid !== 'string' || typeof timestamp !== 'string') return

      const message = buildMessage(parsed, type as 'user' | 'assistant' | 'tool_result')
      if (!message) return

      const historyMessage: HistoryMessage = {
        type: type as 'user' | 'assistant' | 'tool_result',
        uuid,
        parentUuid: typeof parentUuid === 'string' ? parentUuid : null,
        timestamp,
        content: message,
        isSidechain: isSidechain === true,
      }

      index++
      if (index <= offset) return
      if (messages.length >= limit) return

      messages.push(historyMessage)
    })

    rl.on('close', () => {
      resolve(ok(messages))
    })

    rl.on('error', (error) => {
      resolve(err(appError('HISTORY_READ_ERROR', `Failed to read history file: ${String(error)}`)))
    })
  })
}

function buildMessage(
  parsed: Record<string, unknown>,
  type: 'user' | 'assistant' | 'tool_result',
): MessageContent | null {
  if (type === 'user') {
    const message = parsed['message']
    if (!isObject(message)) return null
    const content = message['content']
    const text = typeof content === 'string' ? content : extractTextFromContent(content)
    return { kind: 'user', text }
  }

  if (type === 'assistant') {
    const message = parsed['message']
    if (!isObject(message)) return null
    const content = message['content']
    if (!Array.isArray(content)) return null

    const blocks: AssistantContentBlock[] = []
    for (const block of content) {
      if (!isObject(block)) continue
      const blockType = block['type']

      if (blockType === 'text') {
        const text = block['text']
        if (typeof text === 'string') {
          blocks.push({ type: 'text', text })
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
          blocks.push({ type: 'tool_use', id, name, input: toolInput })
        }
      }
    }

    return { kind: 'assistant', blocks }
  }

  if (type === 'tool_result') {
    const toolUseId = parsed['tool_use_id']
    const content = parsed['content']
    const isError = parsed['is_error']

    if (typeof toolUseId !== 'string') return null

    const output =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter(isObject)
              .map((b) => (b['type'] === 'text' ? String(b['text'] ?? '') : ''))
              .join('')
          : ''

    return {
      kind: 'tool_result',
      toolUseId,
      output,
      isError: isError === true ? true : undefined,
    }
  }

  return null
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(isObject)
      .map((b) => (b['type'] === 'text' ? String(b['text'] ?? '') : ''))
      .join('')
  }
  return ''
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
