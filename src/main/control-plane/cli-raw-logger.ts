import { createWriteStream, mkdirSync, WriteStream } from 'fs'
import { join } from 'path'
import { app } from 'electron'

const sessionRawStreams = new Map<string, WriteStream>()

function getSessionsDir(): string {
  const dir = join(app.getPath('logs'), 'sessions')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function startSession(sessionId: string): void {
  const logPath = join(getSessionsDir(), `cli-raw-${sessionId}.log`)
  const stream = createWriteStream(logPath, { flags: 'a' })
  sessionRawStreams.set(sessionId, stream)
  const header = `\n${'─'.repeat(80)}\n[${new Date().toISOString()}] SESSION START  id=${sessionId}\n${'─'.repeat(80)}\n`
  stream.write(header)
}

export function appendLine(sessionId: string, line: string): void {
  const stream = sessionRawStreams.get(sessionId)
  if (stream) {
    stream.write(line + '\n')
  }
}

export function endSession(sessionId: string): void {
  const stream = sessionRawStreams.get(sessionId)
  if (stream) {
    stream.end()
    sessionRawStreams.delete(sessionId)
  }
}
