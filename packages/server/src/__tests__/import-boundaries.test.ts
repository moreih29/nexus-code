import { describe, it, expect } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const FORBIDDEN = /from ['"](?:\.\.\/)+adapters\/claude-code\//
const BASE = path.resolve(import.meta.dirname, '..')

const BASELINE_LEAKS = new Set([
  'routes/session.ts',
  'routes/events.ts',
  'routes/cli-settings.ts',
  'services/session-lifecycle-service.ts',
])

async function collectTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const out: string[] = []
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue
      out.push(...(await collectTsFiles(p)))
    } else if (e.name.endsWith('.ts')) {
      out.push(p)
    }
  }
  return out
}

describe('adapter import boundaries (leak canary)', () => {
  const scanTargets = ['routes', 'services', 'domain']
  for (const target of scanTargets) {
    it(`${target}/ does not import adapters/claude-code/** beyond baseline`, async () => {
      const files = await collectTsFiles(path.join(BASE, target))
      const leaks: string[] = []
      for (const file of files) {
        const content = await readFile(file, 'utf-8')
        if (FORBIDDEN.test(content)) {
          leaks.push(path.relative(BASE, file))
        }
      }
      const newLeaks = leaks.filter((f) => !BASELINE_LEAKS.has(f))
      expect(
        newLeaks,
        `New adapter/claude-code import detected:\n${newLeaks.join('\n')}\n` +
          `Baseline allowlist (Phase 3 cleanup target): ${[...BASELINE_LEAKS].join(', ')}`,
      ).toEqual([])
    })
  }
})
