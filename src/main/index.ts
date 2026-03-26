import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { is } from '@electron-toolkit/utils'
import { IpcChannel } from '../shared/ipc'
import type {
  RespondPermissionRequest,
  RespondPermissionResponse,
  StartRequest,
  StartResponse,
  PromptRequest,
  PromptResponse,
  CancelRequest,
  CancelResponse,
  StatusRequest,
  StatusResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  WorkspaceEntry,
  WorkspaceListResponse,
  WorkspaceAddResponse,
  WorkspaceRemoveRequest,
  WorkspaceRemoveResponse,
} from '../shared/types'
import { PermissionHandler } from './permission-handler'
import { HookServer } from './hook-server'
import { RunManager } from './run-manager'
import { SessionManager } from './session-manager'
import { PluginHost } from './plugin-host'
import { AgentTracker } from './agent-tracker'

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

// ── Workspace persistence ─────────────────────────────────────────────────

function workspacesFilePath(): string {
  return join(app.getPath('home'), '.nexus-code', 'workspaces.json')
}

async function readWorkspaces(): Promise<WorkspaceEntry[]> {
  try {
    const raw = await readFile(workspacesFilePath(), 'utf8')
    return JSON.parse(raw) as WorkspaceEntry[]
  } catch {
    return []
  }
}

async function writeWorkspaces(workspaces: WorkspaceEntry[]): Promise<void> {
  const filePath = workspacesFilePath()
  await mkdir(join(filePath, '..'), { recursive: true })
  await writeFile(filePath, JSON.stringify(workspaces, null, 2), 'utf8')
}

function getActiveWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}

function registerIpcHandlers(): void {
  // Renderer → Main: 퍼미션 응답
  ipcMain.handle(
    IpcChannel.RESPOND_PERMISSION,
    (_event, req: RespondPermissionRequest): RespondPermissionResponse => {
      const ok = permissionHandler.respond(req.requestId, req.approved)
      return { ok }
    }
  )

  // ── START ────────────────────────────────────────────────────────────────
  ipcMain.handle(IpcChannel.START, async (_event, req: StartRequest): Promise<StartResponse> => {
    const manager = new RunManager()
    const win = getActiveWindow()

    manager.on('text_chunk', (data) => win?.webContents.send(IpcChannel.TEXT_CHUNK, data))
    manager.on('tool_call', (data) => win?.webContents.send(IpcChannel.TOOL_CALL, data))
    manager.on('tool_result', (data) => win?.webContents.send(IpcChannel.TOOL_RESULT, data))
    manager.on('permission_request', (data) =>
      win?.webContents.send(IpcChannel.PERMISSION_REQUEST, data)
    )
    manager.on('session_end', (data) => {
      win?.webContents.send(IpcChannel.SESSION_END, data)
      sessions.delete(data.sessionId)
    })
    manager.on('error', (data) => {
      console.error('[RunManager error]', data)
      win?.webContents.send(IpcChannel.ERROR, data)
    })

    try {
      const sessionId = manager.start({
        prompt: req.prompt,
        cwd: req.cwd,
        permissionMode: req.permissionMode,
        hookUrl: req.permissionMode === 'manual' ? hookServer.hookUrl('') : undefined,
      })

      console.log('[START]', { sessionId, cwd: req.cwd, prompt: req.prompt.slice(0, 50) })
      sessions.set(sessionId, manager)
      return { sessionId }
    } catch (err) {
      console.error('[START failed]', err)
      throw err
    }
  })

  // ── PROMPT ───────────────────────────────────────────────────────────────
  ipcMain.handle(IpcChannel.PROMPT, (_event, req: PromptRequest): PromptResponse => {
    const manager = sessions.get(req.sessionId)
    if (!manager) return { ok: false }
    return { ok: manager.sendPrompt(req.message) }
  })

  // ── CANCEL ───────────────────────────────────────────────────────────────
  ipcMain.handle(IpcChannel.CANCEL, (_event, req: CancelRequest): CancelResponse => {
    const manager = sessions.get(req.sessionId)
    if (!manager) return { ok: false }
    return { ok: manager.cancel() }
  })

  // ── STATUS ───────────────────────────────────────────────────────────────
  ipcMain.handle(IpcChannel.STATUS, (_event, req: StatusRequest): StatusResponse => {
    const manager = sessions.get(req.sessionId)
    return { status: manager ? manager.getStatus() : 'ended', sessionId: req.sessionId }
  })

  // ── LIST_SESSIONS ────────────────────────────────────────────────────────
  ipcMain.handle(
    IpcChannel.LIST_SESSIONS,
    async (_event, _req: ListSessionsRequest): Promise<ListSessionsResponse> => {
      const sessions = await sessionManager.listSessions()
      return { sessions }
    }
  )

  // ── WORKSPACE_LIST ───────────────────────────────────────────────────────
  ipcMain.handle(IpcChannel.WORKSPACE_LIST, async (): Promise<WorkspaceListResponse> => {
    const workspaces = await readWorkspaces()
    return { workspaces }
  })

  // ── WORKSPACE_ADD ────────────────────────────────────────────────────────
  ipcMain.handle(IpcChannel.WORKSPACE_ADD, async (): Promise<WorkspaceAddResponse> => {
    const win = getActiveWindow()
    const result = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
      properties: ['openDirectory'],
      title: '워크스페이스 폴더 선택',
    })

    if (result.canceled || result.filePaths.length === 0) {
      return { workspace: null, cancelled: true }
    }

    const folderPath = result.filePaths[0]
    const parts = folderPath.split('/')
    const name = parts[parts.length - 1] || folderPath

    const workspaces = await readWorkspaces()
    if (!workspaces.some((w) => w.path === folderPath)) {
      workspaces.push({ path: folderPath, name })
      await writeWorkspaces(workspaces)
    }

    return { workspace: { path: folderPath, name }, cancelled: false }
  })

  // ── WORKSPACE_REMOVE ─────────────────────────────────────────────────────
  ipcMain.handle(
    IpcChannel.WORKSPACE_REMOVE,
    async (_event, req: WorkspaceRemoveRequest): Promise<WorkspaceRemoveResponse> => {
      const workspaces = await readWorkspaces()
      const filtered = workspaces.filter((w) => w.path !== req.path)
      await writeWorkspaces(filtered)
      return { ok: true }
    }
  )

  // ── READ_FILE (MarkdownViewer용) ─────────────────────────────────────────
  ipcMain.handle('ipc:read-file', async (_event, req: { path: string }) => {
    try {
      const { readFile } = await import('fs/promises')
      const content = await readFile(req.path, 'utf8')
      return { ok: true, content }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // ── LOAD_SESSION (--resume) ───────────────────────────────────────────────
  ipcMain.handle(
    IpcChannel.LOAD_SESSION,
    async (_event, req: LoadSessionRequest): Promise<LoadSessionResponse> => {
      if (!req.sessionId) return { ok: false }

      const win = getActiveWindow()
      const manager = new RunManager()

      manager.on('text_chunk', (data) => win?.webContents.send(IpcChannel.TEXT_CHUNK, data))
      manager.on('tool_call', (data) => win?.webContents.send(IpcChannel.TOOL_CALL, data))
      manager.on('tool_result', (data) => win?.webContents.send(IpcChannel.TOOL_RESULT, data))
      manager.on('permission_request', (data) =>
        win?.webContents.send(IpcChannel.PERMISSION_REQUEST, data)
      )
      manager.on('session_end', (data) => {
        win?.webContents.send(IpcChannel.SESSION_END, data)
        sessions.delete(data.sessionId)
      })
      manager.on('error', (data) => win?.webContents.send(IpcChannel.ERROR, data))

      const sessionId = manager.start({
        prompt: '',
        cwd: process.cwd(),
        permissionMode: 'manual',
        sessionId: req.sessionId,
        hookUrl: hookServer.hookUrl(req.sessionId),
      })
      sessions.set(sessionId, manager)
      return { ok: true }
    }
  )
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
  await hookServer.start()
  sessionManager.startWatching()
  await pluginHost.start()
  registerIpcHandlers()
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
