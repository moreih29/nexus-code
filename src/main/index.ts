import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { PermissionHandler } from './control-plane/permission-handler'
import { HookServer } from './control-plane/hook-server'
import { RunManager } from './control-plane/run-manager'
import { SessionManager } from './control-plane/session-manager'
import { PluginHost } from './plugin-host'
import { AgentTracker } from './control-plane/agent-tracker'
import { registerIpcHandlers } from './ipc/handlers'
import { loadPermanentRules } from './control-plane/approval-store'

const permissionHandler = new PermissionHandler()
const hookServer = new HookServer({ permissionHandler })
const sessionManager = new SessionManager()
const pluginHost = new PluginHost(join(app.getAppPath(), 'plugins'))
const agentTracker = new AgentTracker()

// 세션 ID → RunManager 맵
const sessions = new Map<string, RunManager>()

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// HookServer pre-tool-use → AgentTracker 연결
hookServer.on('pre-tool-use', (payload) => {
  agentTracker.onPreToolUse(
    payload.agentId ?? 'main',
    payload.toolName,
    payload.toolInput,
    payload.toolUseId,
  )
})

app.whenReady().then(async () => {
  const permanentRules = await loadPermanentRules()
  permissionHandler.setPermanentRules(permanentRules)

  await hookServer.start()
  sessionManager.startWatching()
  await pluginHost.start()
  registerIpcHandlers({
    getWindow: () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null,
    sessions,
    hookServer,
    sessionManager,
    permissionHandler,
    pluginHost,
  })
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  // 실행 중인 CLI 프로세스 모두 정리
  for (const manager of sessions.values()) {
    manager.cancel()
  }
  sessions.clear()

  permissionHandler.rejectAll()
  sessionManager.stopWatching()
  pluginHost.stop()
  agentTracker.reset()
  await hookServer.stop()
  app.quit()
})

export { hookServer, permissionHandler, agentTracker, pluginHost }
