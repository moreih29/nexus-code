import fs from 'fs'
import path from 'path'
import { BrowserWindow } from 'electron'
import { IpcChannel } from '../../shared/ipc'
import type { PluginDataEvent } from '../../shared/types'
import { logger } from '../logger'
import { loadManifest, resolvePath } from './loader'
import type { PluginManifest, PanelManifest, DataSourceFileWatch } from './loader'

// ─── PluginHost ────────────────────────────────────────────────────────────

interface ActiveWatcher {
  watcher: fs.FSWatcher
  resolvedPath: string
}

export class PluginHost {
  private watchers = new Map<string, ActiveWatcher>() // `${pluginId}:${panelId}` → watcher
  private pluginsDir: string
  private currentCwd: string | undefined
  private currentSessionId: string | undefined

  constructor(pluginsDir: string) {
    this.pluginsDir = pluginsDir
  }

  /** 워크스페이스 CWD가 변경될 때 호출 — 기존 watcher를 재시작한다 */
  async setCwd(cwd: string, sessionId?: string): Promise<void> {
    this.currentCwd = cwd
    this.currentSessionId = sessionId
    this.stop()
    await this.start()
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
        const manifest = await loadManifest(manifestPath)
        this.loadPlugin(manifest)
      } catch {
        logger.plugin.warn('manifest load failed', { entry })
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

    const resolvedFilePath = resolvePath(source.path, this.currentCwd)

    // 초기 데이터 전송 (파일이 존재하면)
    this.sendFileData(pluginId, panel.id, resolvedFilePath)

    let watcher: fs.FSWatcher
    try {
      watcher = fs.watch(resolvedFilePath, () => {
        this.sendFileData(pluginId, panel.id, resolvedFilePath)
      })
    } catch {
      // 파일이 아직 없을 수 있음 — 부모 디렉토리를 감시
      const dir = path.dirname(resolvedFilePath)
      const filename = path.basename(resolvedFilePath)
      try {
        watcher = fs.watch(dir, (_eventType, changedFile) => {
          if (changedFile === filename) {
            this.sendFileData(pluginId, panel.id, resolvedFilePath)
          }
        })
      } catch {
        logger.plugin.debug('watch failed', { resolvedFilePath })
        return
      }
    }

    this.watchers.set(key, { watcher, resolvedPath: resolvedFilePath })
  }

  private sendFileData(pluginId: string, panelId: string, filePath: string): void {
    let data: unknown = null
    try {
      const raw = fs.readFileSync(filePath, 'utf8')
      data = JSON.parse(raw)
    } catch {
      logger.plugin.debug('file read failed', { filePath })
      return // 파일 없거나 파싱 실패 시 전송하지 않음
    }

    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return

    const event: PluginDataEvent = { pluginId, panelId, data, sessionId: this.currentSessionId }
    win.webContents.send(IpcChannel.PLUGIN_DATA, event)
  }
}
