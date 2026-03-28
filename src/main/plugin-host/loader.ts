import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

// ─── Manifest 스키마 ───────────────────────────────────────────────────────

export interface DataSourceFileWatch {
  type: 'file-watch'
  path: string // {branch} 플레이스홀더 포함 가능
}

export interface DataSourceHookEvents {
  type: 'hook-events'
  filter?: string
}

export type DataSource = DataSourceFileWatch | DataSourceHookEvents

export interface PanelManifest {
  id: string
  title: string
  position: 'right' | 'left' | 'bottom'
  dataSource: DataSource
  renderer: 'tree' | 'markdown' | 'timeline'
}

export interface PluginManifest {
  name: string
  panels: PanelManifest[]
}

// ─── Loader 함수 ───────────────────────────────────────────────────────────

export async function loadManifest(manifestPath: string): Promise<PluginManifest> {
  const raw = await fs.promises.readFile(manifestPath, 'utf8')
  return JSON.parse(raw) as PluginManifest
}

/** {branch} 플레이스홀더를 현재 git 브랜치 이름으로 치환하고, baseCwd가 있으면 절대경로로 변환한다 */
export function resolvePath(rawPath: string, baseCwd?: string): string {
  let resolved = rawPath

  if (resolved.includes('{branch}')) {
    let branch = 'main'
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', {
        encoding: 'utf8',
        timeout: 3000,
        cwd: baseCwd,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      // git 실패 시 폴백
    }
    resolved = resolved.replace(/\{branch\}/g, branch)
  }

  if (baseCwd && !path.isAbsolute(resolved)) {
    return path.resolve(baseCwd, resolved)
  }

  return resolved
}
