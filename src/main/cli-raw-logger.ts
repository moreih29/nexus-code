import { mkdirSync, appendFileSync } from 'fs'
import { join } from 'path'

const LOG_DIR = join(process.cwd(), 'logs')
const LOG_PATH = join(LOG_DIR, 'cli-raw.log')

mkdirSync(LOG_DIR, { recursive: true })

export function startSession(sessionId: string): void {
  const ts = new Date().toISOString()
  const divider = '─'.repeat(80)
  appendFileSync(LOG_PATH, `\n${divider}\n[${ts}] SESSION START  id=${sessionId}\n${divider}\n`, 'utf8')
}

export function appendLine(line: string): void {
  appendFileSync(LOG_PATH, line + '\n', 'utf8')
}
