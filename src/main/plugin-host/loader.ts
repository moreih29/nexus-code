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

/** {branch} 플레이스홀더를 현재 git 브랜치 이름으로 치환한다 */
export function resolvePath(rawPath: string): string {
  if (!rawPath.includes('{branch}')) return rawPath

  let branch = 'main'
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    // git 실패 시 폴백
  }

  return rawPath.replace(/\{branch\}/g, branch)
}
