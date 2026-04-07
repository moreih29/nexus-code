import { Hono } from 'hono'
import { execSync } from 'node:child_process'

interface GitFileEntry {
  path: string
  status: string
  additions: number
  deletions: number
}

interface GitCommit {
  hash: string
  message: string
  date: string
}

interface GitInfo {
  branch: string
  staged: GitFileEntry[]
  changes: GitFileEntry[]
  commits: GitCommit[]
}

interface GitErrorResponse {
  error: string
}

function runGit(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

function parseDiffNumstat(cwd: string, cached: boolean): GitFileEntry[] {
  const flag = cached ? '--cached' : ''
  try {
    const raw = runGit(cwd, `diff --numstat ${flag}`)
    if (!raw) return []
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('\t')
        const additions = parseInt(parts[0] ?? '0', 10) || 0
        const deletions = parseInt(parts[1] ?? '0', 10) || 0
        const filePath = parts[2] ?? ''
        return { path: filePath, status: 'M', additions, deletions }
      })
  } catch {
    return []
  }
}

function parseStatus(cwd: string): { staged: GitFileEntry[]; changes: GitFileEntry[] } {
  let raw: string
  try {
    raw = runGit(cwd, 'status --porcelain')
  } catch {
    return { staged: [], changes: [] }
  }

  if (!raw) return { staged: [], changes: [] }

  const stagedPaths = new Set<string>()
  const changedPaths = new Set<string>()
  const stagedStatuses = new Map<string, string>()
  const changedStatuses = new Map<string, string>()

  for (const line of raw.split('\n').filter(Boolean)) {
    const xy = line.slice(0, 2)
    const filePath = line.slice(3)
    const x = xy[0] ?? ' '
    const y = xy[1] ?? ' '

    if (x !== ' ' && x !== '?') {
      stagedPaths.add(filePath)
      stagedStatuses.set(filePath, x)
    }
    if (y !== ' ' && y !== '?') {
      changedPaths.add(filePath)
      changedStatuses.set(filePath, y)
    }
  }

  const stagedNumstat = parseDiffNumstat(cwd, true)
  const changedNumstat = parseDiffNumstat(cwd, false)

  const numstatByPath = (entries: GitFileEntry[]) => {
    const map = new Map<string, { additions: number; deletions: number }>()
    for (const e of entries) map.set(e.path, { additions: e.additions, deletions: e.deletions })
    return map
  }

  const stagedMap = numstatByPath(stagedNumstat)
  const changedMap = numstatByPath(changedNumstat)

  const staged: GitFileEntry[] = [...stagedPaths].map((p) => ({
    path: p,
    status: stagedStatuses.get(p) ?? 'M',
    additions: stagedMap.get(p)?.additions ?? 0,
    deletions: stagedMap.get(p)?.deletions ?? 0,
  }))

  const changes: GitFileEntry[] = [...changedPaths].map((p) => ({
    path: p,
    status: changedStatuses.get(p) ?? 'M',
    additions: changedMap.get(p)?.additions ?? 0,
    deletions: changedMap.get(p)?.deletions ?? 0,
  }))

  return { staged, changes }
}

function parseCommits(cwd: string): GitCommit[] {
  try {
    const raw = runGit(cwd, 'log --pretty=format:%h\x1f%s\x1f%ar -10')
    if (!raw) return []
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('\x1f')
        return {
          hash: parts[0] ?? '',
          message: parts[1] ?? '',
          date: parts[2] ?? '',
        }
      })
  } catch {
    return []
  }
}

const DIFF_LINE_LIMIT = 5000

export function createGitRouter() {
  const router = new Hono()

  router.get('/:path{.+}/git', (c) => {
    const rawPath = c.req.param('path')
    const workspacePath = '/' + rawPath

    let branch: string
    try {
      branch = runGit(workspacePath, 'rev-parse --abbrev-ref HEAD')
    } catch {
      const response: GitErrorResponse = { error: 'not-a-git-repo' }
      return c.json(response)
    }

    const { staged, changes } = parseStatus(workspacePath)
    const commits = parseCommits(workspacePath)

    const info: GitInfo = { branch, staged, changes, commits }
    return c.json(info)
  })

  router.get('/:path{.+}/git/diff', (c) => {
    const rawPath = c.req.param('path')
    const workspacePath = '/' + rawPath
    const file = c.req.query('file') ?? ''
    const stagedParam = c.req.query('staged')
    const staged = stagedParam === 'true' || stagedParam === '1'

    if (!file) {
      return c.json({ error: 'file param required' }, 400)
    }

    try {
      const stagedFlag = staged ? '--staged' : ''
      const raw = runGit(workspacePath, `diff ${stagedFlag} -- ${JSON.stringify(file)}`)
      const lines = raw.split('\n')
      const truncated = lines.length > DIFF_LINE_LIMIT ? lines.slice(0, DIFF_LINE_LIMIT) : lines
      return c.json({ diff: truncated.join('\n') })
    } catch {
      return c.json({ diff: '' })
    }
  })

  router.get('/:path{.+}/git/show', (c) => {
    const rawPath = c.req.param('path')
    const workspacePath = '/' + rawPath
    const hash = c.req.query('hash') ?? ''

    if (!hash) {
      return c.json({ error: 'hash param required' }, 400)
    }

    try {
      const stat = runGit(workspacePath, `show --stat ${hash}`)
      const messageRaw = runGit(workspacePath, `log -1 --pretty=format:%B ${hash}`)
      const nameOnlyRaw = runGit(workspacePath, `show --name-only --pretty=format: ${hash}`)
      const files = nameOnlyRaw
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      const statLines = stat.split('\n')
      const truncated = statLines.length > DIFF_LINE_LIMIT ? statLines.slice(0, DIFF_LINE_LIMIT) : statLines
      return c.json({ message: messageRaw, files, stat: truncated.join('\n') })
    } catch {
      return c.json({ message: '', files: [], stat: '' })
    }
  })

  return router
}
