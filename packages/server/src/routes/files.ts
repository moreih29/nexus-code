import { Hono } from 'hono'
import { execSync } from 'node:child_process'

export function createFilesRouter() {
  const router = new Hono()

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
