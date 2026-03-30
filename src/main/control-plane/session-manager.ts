import fs from 'fs'
import { createInterface } from 'readline'
import path from 'path'
import os from 'os'
import type { SessionInfo } from '../../shared/types'
import { logger } from '../logger'

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

/** JSONL 파일에서 첫 번째 user 메시지 텍스트를 preview로 추출한다 (스트림 방식) */
async function extractPreview(filePath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let resolved = false
    const done = (value: string | undefined) => {
      if (!resolved) {
        resolved = true
        stream.destroy()
        resolve(value)
      }
    }

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })

    rl.on('line', (line: string) => {
      if (!line.trim()) return
      try {
        const entry = JSON.parse(line) as SessionFileEntry
        if (entry.type === 'user' && entry.message?.role === 'user') {
          const c = entry.message.content
          if (typeof c === 'string') {
            done(c.slice(0, 120))
            return
          }
          if (Array.isArray(c)) {
            for (const block of c as Array<{ type?: string; text?: string }>) {
              if (block.type === 'text' && typeof block.text === 'string') {
                done(block.text.slice(0, 120))
                return
              }
            }
          }
        }
      } catch {
        // 파싱 실패한 줄은 건너뜀
      }
    })

    rl.on('close', () => done(undefined))
    rl.on('error', () => done(undefined))
    stream.on('error', () => done(undefined))
  })
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
      logger.session.debug('scan error', { err: String(err) })
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
            const preview = await extractPreview(filePath)

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

  /**
   * projectDir 이름(-로 구분된 경로)을 실제 cwd로 역변환.
   *
   * Claude CLI 인코딩 방식: 경로의 모든 `/`를 `-`로 치환하고 맨 앞 `/`도 `-`로 변환.
   * 예) `/Users/kih/my-project` → `-Users-kih-my-project`
   *
   * 한계: 원래 경로에 `-`가 포함된 경우(예: `my-project`)와 경로 구분자(`/`)를
   * 구별할 수 없으므로 완전한 역변환은 불가능하다. 이 함수는 JSONL 파일에서
   * cwd를 읽지 못했을 때의 폴백으로만 사용되며, 실제 경로와 다를 수 있다.
   */
  private projectDirToCwd(dirName: string): string {
    // 맨 앞 '-'를 '/'로 교체 후 나머지 '-'를 '/'로 치환
    // 주의: 원래 경로에 '-'가 있으면 잘못 복원될 수 있음 (CLI 측 한계)
    return '/' + dirName.replace(/^-/, '').replace(/-/g, '/')
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
