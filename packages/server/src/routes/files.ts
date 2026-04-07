import { Hono } from 'hono'
import { execSync } from 'node:child_process'
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join, extname } from 'node:path'

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.pdf', '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm',
  '.mp3', '.mp4', '.wav', '.ogg', '.flac', '.avi', '.mov', '.mkv',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.db', '.sqlite', '.sqlite3',
])

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.html': 'html', '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss', '.sass': 'scss',
  '.less': 'less',
  '.json': 'json',
  '.jsonc': 'json',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.toml': 'toml',
  '.md': 'markdown', '.mdx': 'markdown',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.sql': 'sql',
  '.graphql': 'graphql', '.gql': 'graphql',
  '.xml': 'xml',
  '.dockerfile': 'dockerfile',
  '.env': 'shell',
}

const MAX_FILE_SIZE = 1024 * 1024 // 1MB

export function createFilesRouter() {
  const router = new Hono()

  router.get('/:path{.+}/files/content', (c) => {
    const workspacePath = '/' + c.req.param('path')
    const filePath = c.req.query('filePath')

    if (!filePath) {
      return c.json({ error: 'filePath query parameter is required' }, 400)
    }

    const absolutePath = join(workspacePath, filePath)

    // Prevent path traversal outside the workspace
    if (!absolutePath.startsWith(workspacePath)) {
      return c.json({ error: 'Access denied' }, 403)
    }

    try {
      const stat = statSync(absolutePath)

      if (!stat.isFile()) {
        return c.json({ error: 'Not a file' }, 400)
      }

      const ext = extname(filePath).toLowerCase()
      const language = EXTENSION_LANGUAGE_MAP[ext] ?? 'plaintext'

      if (BINARY_EXTENSIONS.has(ext)) {
        return c.json({ binary: true, size: stat.size })
      }

      let content: string
      if (stat.size > MAX_FILE_SIZE) {
        const buffer = Buffer.alloc(MAX_FILE_SIZE)
        const fd = openSync(absolutePath, 'r')
        readSync(fd, buffer, 0, MAX_FILE_SIZE, 0)
        closeSync(fd)
        content = buffer.toString('utf-8') + '\n\n[파일이 너무 큽니다 — 처음 1MB만 표시합니다]'
      } else {
        content = readFileSync(absolutePath, 'utf-8')
      }

      return c.json({ content, language })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return c.json({ error: `파일을 읽을 수 없습니다: ${message}` }, 500)
    }
  })

  router.get('/:path{.+}/files', (c) => {
    const workspacePath = '/' + c.req.param('path')

    let files: { path: string; status?: 'M' | 'A' | 'D' }[] = []

    try {
      const isGit = execSync('git rev-parse --is-inside-work-tree', {
        cwd: workspacePath,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim() === 'true'

      if (isGit) {
        const lsOutput = execSync('git ls-files', {
          cwd: workspacePath,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).toString()

        const paths = lsOutput
          .split('\n')
          .map((p) => p.trim())
          .filter(Boolean)
          .slice(0, 1000)

        const statusMap = new Map<string, 'M' | 'A' | 'D'>()

        const statusOutput = execSync('git status --porcelain', {
          cwd: workspacePath,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).toString()

        for (const line of statusOutput.split('\n')) {
          if (line.length < 3) continue
          const xy = line.slice(0, 2)
          const filePath = line.slice(3).trim()
          if (xy.includes('M')) statusMap.set(filePath, 'M')
          else if (xy.includes('A') || xy === '??') statusMap.set(filePath, 'A')
          else if (xy.includes('D')) statusMap.set(filePath, 'D')
        }

        files = paths.map((p) => {
          const s = statusMap.get(p)
          return s ? { path: p, status: s } : { path: p }
        })
      }
    } catch {
      // git not available or not a git repo — return empty list
    }

    return c.json({ files })
  })

  return router
}
