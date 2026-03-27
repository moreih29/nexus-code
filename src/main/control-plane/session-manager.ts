import fs from 'fs'
import path from 'path'
import os from 'os'
import type { SessionInfo } from '../../shared/types'
import log from '../logger'

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects')

interface SessionFileEntry {
  type?: string
  timestamp?: string
  cwd?: string
  sessionId?: string
  message?: {
    role?: string
    content?: unknown
  }
}

/** JSONL 파일의 첫 번째 줄에서 메타데이터를 추출한다 */
function parseFirstLine(filePath: string): SessionFileEntry | null {
  try {
    const fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(4096)
    const bytesRead = fs.readSync(fd, buf, 0, 4096, 0)
    fs.closeSync(fd)

    const chunk = buf.toString('utf8', 0, bytesRead)
    const newlineIdx = chunk.indexOf('\n')
    const firstLine = newlineIdx >= 0 ? chunk.slice(0, newlineIdx) : chunk
    return JSON.parse(firstLine) as SessionFileEntry
  } catch {
    return null
  }
}

/** JSONL 파일에서 첫 번째 user 메시지 텍스트를 preview로 추출한다 */
function extractPreview(filePath: string): string | undefined {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as SessionFileEntry
        if (entry.type === 'user' && entry.message?.role === 'user') {
          const c = entry.message.content
          if (typeof c === 'string') return c.slice(0, 120)
          if (Array.isArray(c)) {
            for (const block of c as Array<{ type?: string; text?: string }>) {
              if (block.type === 'text' && typeof block.text === 'string') {
                return block.text.slice(0, 120)
              }
            }
          }
        }
      } catch {
        // 파싱 실패한 줄은 건너뜀
      }
    }
  } catch {
    // 파일 읽기 실패
  }
  return undefined
}

export interface ListSessionsOptions {
  /** 특정 cwd 경로로 필터링. undefined면 전체 반환 */
  cwd?: string
  limit?: number
}

export class SessionManager {
  private watcher: fs.FSWatcher | null = null
  private cache: SessionInfo[] | null = null
  private cacheTime = 0
  private readonly cacheTtlMs = 5_000

  /** ~/.claude/projects/ 아래 모든 세션을 최신 순으로 반환 */
  async listSessions(options: ListSessionsOptions = {}): Promise<SessionInfo[]> {
    const now = Date.now()
    if (this.cache && now - this.cacheTime < this.cacheTtlMs) {
      return this.applyFilter(this.cache, options)
    }

    const sessions = await this.scanSessions()
    this.cache = sessions
    this.cacheTime = now
    return this.applyFilter(sessions, options)
  }

  private applyFilter(sessions: SessionInfo[], options: ListSessionsOptions): SessionInfo[] {
    let result = sessions
    if (options.cwd) {
      result = result.filter((s) => s.cwd === options.cwd)
    }
    if (options.limit) {
      result = result.slice(0, options.limit)
    }
    return result
  }

  private async scanSessions(): Promise<SessionInfo[]> {
    const sessions: SessionInfo[] = []

    let projectDirs: string[]
    try {
      projectDirs = await fs.promises.readdir(CLAUDE_DIR)
    } catch (err) {
      log.debug('[SessionManager] scan error:', String(err))
      return []
    }

    await Promise.all(
      projectDirs.map(async (projectDir) => {
        const projectPath = path.join(CLAUDE_DIR, projectDir)

        let files: string[]
        try {
          files = await fs.promises.readdir(projectPath)
        } catch {
          return
        }

        await Promise.all(
          files.map(async (file) => {
            if (!file.endsWith('.jsonl')) return

            const filePath = path.join(projectPath, file)
            let stat: fs.Stats
            try {
              stat = await fs.promises.stat(filePath)
            } catch {
              return
            }

            const firstEntry = parseFirstLine(filePath)
            if (!firstEntry) return

            const sessionId =
              firstEntry.sessionId ?? path.basename(file, '.jsonl')
            const cwd = firstEntry.cwd ?? this.projectDirToCwd(projectDir)
            const createdAt = firstEntry.timestamp ?? stat.mtime.toISOString()
            const preview = extractPreview(filePath)

            sessions.push({ id: sessionId, createdAt, cwd, preview })
          })
        )
      })
    )

    // 최근 세션 순 정렬
    sessions.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )

    return sessions
  }

  /** projectDir 이름(-로 구분된 경로)을 실제 cwd로 역변환 */
  private projectDirToCwd(dirName: string): string {
    // '-Users-kih-...' → '/Users/kih/...'
    return dirName.replace(/^-/, '/').replace(/-/g, '/')
  }

  /** fs.watch로 세션 디렉토리 변경 감지, 캐시 무효화 */
  startWatching(): void {
    if (this.watcher) return
    try {
      this.watcher = fs.watch(CLAUDE_DIR, { recursive: false }, () => {
        this.cache = null
      })
    } catch {
      // CLAUDE_DIR이 없거나 watch 실패 시 무시
    }
  }

  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
  }
}
