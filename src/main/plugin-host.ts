import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { BrowserWindow } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type { PluginDataEvent } from '../shared/types'

// ─── Manifest 스키마 ───────────────────────────────────────────────────────

interface DataSourceFileWatch {
  type: 'file-watch'
  path: string // {branch} 플레이스홀더 포함 가능
}

interface DataSourceHookEvents {
  type: 'hook-events'
  filter?: string
}

type DataSource = DataSourceFileWatch | DataSourceHookEvents

interface PanelManifest {
  id: string
  title: string
  position: 'right' | 'left' | 'bottom'
  dataSource: DataSource
  renderer: 'tree' | 'markdown' | 'timeline'
}

interface PluginManifest {
  name: string
  panels: PanelManifest[]
}

// ─── PluginHost ────────────────────────────────────────────────────────────

interface ActiveWatcher {
  watcher: fs.FSWatcher
  resolvedPath: string
}

export class PluginHost {
  private watchers = new Map<string, ActiveWatcher>() // `${pluginId}:${panelId}` → watcher
  private pluginsDir: string

  constructor(pluginsDir: string) {
    this.pluginsDir = pluginsDir
  }

  /** plugins/ 디렉토리 아래 모든 플러그인을 로드하고 감시를 시작한다 */
  async start(): Promise<void> {
    let entries: string[]
    try {
      entries = await fs.promises.readdir(this.pluginsDir)
    } catch {
      // plugins/ 디렉토리가 없으면 조용히 종료
      return
    }

    for (const entry of entries) {
      const manifestPath = path.join(this.pluginsDir, entry, 'manifest.json')
      try {
        const raw = await fs.promises.readFile(manifestPath, 'utf8')
        const manifest = JSON.parse(raw) as PluginManifest
        this.loadPlugin(manifest)
      } catch {
        // 파싱 실패한 플러그인은 건너뜀
      }
    }
  }

  stop(): void {
    for (const { watcher } of this.watchers.values()) {
      try {
        watcher.close()
      } catch {
        // ignore
      }
    }
    this.watchers.clear()
  }

  private loadPlugin(manifest: PluginManifest): void {
    for (const panel of manifest.panels) {
      if (panel.dataSource.type === 'file-watch') {
        this.watchFile(manifest.name, panel, panel.dataSource)
      }
      // hook-events 타입은 AgentTracker가 직접 처리하므로 여기서는 skip
    }
  }

  private watchFile(pluginId: string, panel: PanelManifest, source: DataSourceFileWatch): void {
    const key = `${pluginId}:${panel.id}`
    if (this.watchers.has(key)) return

    const resolvedPath = this.resolvePath(source.path)

    // 초기 데이터 전송 (파일이 존재하면)
    this.sendFileData(pluginId, panel.id, resolvedPath)

    let watcher: fs.FSWatcher
    try {
      watcher = fs.watch(resolvedPath, () => {
        this.sendFileData(pluginId, panel.id, resolvedPath)
      })
    } catch {
      // 파일이 아직 없을 수 있음 — 부모 디렉토리를 감시
      const dir = path.dirname(resolvedPath)
      const filename = path.basename(resolvedPath)
      try {
        watcher = fs.watch(dir, (_eventType, changedFile) => {
          if (changedFile === filename) {
            this.sendFileData(pluginId, panel.id, resolvedPath)
          }
        })
      } catch {
        return
      }
    }

    this.watchers.set(key, { watcher, resolvedPath })
  }

  private sendFileData(pluginId: string, panelId: string, filePath: string): void {
    let data: unknown = null
    try {
      const raw = fs.readFileSync(filePath, 'utf8')
      data = JSON.parse(raw)
    } catch {
      return // 파일 없거나 파싱 실패 시 전송하지 않음
    }

    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return

    const event: PluginDataEvent = { pluginId, panelId, data }
    win.webContents.send(IpcChannel.PLUGIN_DATA, event)
  }

  /** {branch} 플레이스홀더를 현재 git 브랜치 이름으로 치환한다 */
  private resolvePath(rawPath: string): string {
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
}
