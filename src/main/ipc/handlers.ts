import { ipcMain, dialog, BrowserWindow, Notification } from 'electron'
import { join } from 'path'
import path from 'path'
import { readFile, writeFile, mkdir, readdir, access } from 'fs/promises'
import { watch, readFileSync, existsSync } from 'fs'
import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import { execFile } from 'child_process'
import { promisify } from 'util'
import os from 'os'

const execFileAsync = promisify(execFile)
import { app } from 'electron'
import { IpcChannel } from '../../shared/ipc'
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
  WorkspaceUpdateSessionRequest,
  WorkspaceUpdateSessionResponse,
  ClaudeSettings,
  ReadSettingsRequest,
  ReadSettingsResponse,
  WriteSettingsRequest,
  WriteSettingsResponse,
  DeleteSettingsKeyRequest,
  DeleteSettingsKeyResponse,
  LoadHistoryRequest,
  LoadHistoryResponse,
  HistoryMessage,
  CheckpointCreateRequest,
  CheckpointCreateResponse,
  CheckpointRestoreRequest,
  CheckpointRestoreResponse,
  GitCheckRequest,
  GitCheckResponse,
  GitInitRequest,
  GitInitResponse,
  NexusStateReadRequest,
  NexusStateReadResponse,
  RestartSessionRequest,
  RestartSessionResponse,
  PermissionMode,
  SessionStatus,
  StatusChangeEvent,
} from '../../shared/types'
import { RunManager } from '../control-plane/run-manager'
import { HookServer } from '../control-plane/hook-server'
import { SessionManager } from '../control-plane/session-manager'
import { PermissionHandler } from '../control-plane/permission-handler'
import { PluginHost } from '../plugin-host'
import { AgentTracker } from '../control-plane/agent-tracker'
import { isGitRepo, createCheckpoint, restoreCheckpoint } from '../control-plane/checkpoint-manager'
import { logger } from '../logger'

export interface IpcDeps {
  getWindow: () => BrowserWindow | null
  sessions: Map<string, RunManager>
  hookServer: HookServer
  sessionManager: SessionManager
  permissionHandler: PermissionHandler
  pluginHost: PluginHost
  agentTracker: AgentTracker
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

// ── Settings persistence ──────────────────────────────────────────────────

function globalSettingsPath(): string {
  return join(app.getPath('home'), '.claude', 'settings.json')
}

function projectSettingsPath(cwd: string): string {
  return join(cwd, '.claude', 'settings.local.json')
}

async function readSettingsFile(filePath: string): Promise<ClaudeSettings> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw) as ClaudeSettings
  } catch {
    return {}
  }
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    const sv = source[key]
    const tv = target[key]
    if (sv !== null && typeof sv === 'object' && !Array.isArray(sv) &&
        tv !== null && typeof tv === 'object' && !Array.isArray(tv)) {
      result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>)
    } else {
      result[key] = sv
    }
  }
  return result
}

async function writeSettingsFile(filePath: string, settings: ClaudeSettings): Promise<void> {
  await mkdir(join(filePath, '..'), { recursive: true })
  const existing = await readSettingsFile(filePath)
  const merged = deepMerge(existing as Record<string, unknown>, settings as Record<string, unknown>)
  await writeFile(filePath, JSON.stringify(merged, null, 2), 'utf8')
}

// ── History helpers ───────────────────────────────────────────────────────────

const CLAUDE_PROJECTS_DIR = join(os.homedir(), '.claude', 'projects')
const TOOL_RESULT_TRUNCATE = 2000

/** ~/.claude/projects/ 하위를 순회하여 sessionId에 해당하는 .jsonl 파일 경로를 반환 */
async function findSessionFile(sessionId: string): Promise<string | null> {
  let projectDirs: string[]
  try {
    projectDirs = await readdir(CLAUDE_PROJECTS_DIR)
  } catch {
    return null
  }

  for (const projectDir of projectDirs) {
    const candidate = join(CLAUDE_PROJECTS_DIR, projectDir, `${sessionId}.jsonl`)
    try {
      await access(candidate)
      return candidate
    } catch {
      // 파일 없음 — 다음 디렉토리 시도
    }
  }
  return null
}

interface RawEntry {
  type?: string
  timestamp?: string
  sessionId?: string
  message?: {
    role?: string
    content?: unknown
  }
}

interface RawBlock {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

/** JSONL 파일을 스트리밍으로 읽어 user/assistant 메시지를 파싱 */
async function parseSessionHistory(filePath: string): Promise<HistoryMessage[]> {
  // tool_use id → HistoryMessage 인덱스 매핑 (tool_result 매칭용)
  const toolUseIndexMap = new Map<string, number>()
  const messages: HistoryMessage[] = []

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line.trim()) continue
    let entry: RawEntry
    try {
      entry = JSON.parse(line) as RawEntry
    } catch {
      continue
    }

    const type = entry.type
    if (type !== 'user' && type !== 'assistant') continue

    const msg = entry.message
    if (!msg || msg.role !== type) continue

    const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now()
    const rawContent = msg.content

    if (type === 'assistant') {
      if (!Array.isArray(rawContent)) continue

      const blocks = rawContent as RawBlock[]
      const textParts: string[] = []
      const toolCalls: HistoryMessage['toolCalls'] = []

      for (const block of blocks) {
        if (block.type === 'thinking') continue
        if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text)
        } else if (block.type === 'tool_use' && block.id && block.name) {
          toolCalls.push({
            toolUseId: block.id,
            name: block.name,
            input: block.input ?? {},
          })
        }
      }

      const content = textParts.join('')
      if (content || toolCalls.length > 0) {
        const msgIndex = messages.length
        if (toolCalls.length > 0) {
          for (const tc of toolCalls) {
            toolUseIndexMap.set(tc.toolUseId, msgIndex)
          }
        }
        messages.push({
          role: 'assistant',
          content,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          timestamp,
        })
      }
    } else {
      // user message
      if (Array.isArray(rawContent)) {
        // tool_result 블록 포함 가능
        const blocks = rawContent as RawBlock[]
        let hasToolResults = false

        for (const block of blocks) {
          if (block.type !== 'tool_result') continue
          hasToolResults = true
          const toolUseId = block.tool_use_id
          if (!toolUseId) continue

          const msgIndex = toolUseIndexMap.get(toolUseId)
          if (msgIndex === undefined) continue

          const targetMsg = messages[msgIndex]
          if (!targetMsg?.toolCalls) continue

          let resultContent = ''
          if (typeof block.content === 'string') {
            resultContent = block.content.slice(0, TOOL_RESULT_TRUNCATE)
          } else if (Array.isArray(block.content)) {
            const texts = (block.content as RawBlock[])
              .filter((b) => b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text as string)
            resultContent = texts.join('').slice(0, TOOL_RESULT_TRUNCATE)
          }

          targetMsg.toolCalls = targetMsg.toolCalls.map((tc) =>
            tc.toolUseId === toolUseId
              ? { ...tc, result: resultContent, isError: block.is_error }
              : tc
          )
        }

        if (!hasToolResults) {
          // content 배열이지만 tool_result가 없는 경우 — text 블록 합치기
          const textParts = (blocks as RawBlock[])
            .filter((b) => b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text as string)
          const content = textParts.join('')
          if (content) {
            messages.push({ role: 'user', content, timestamp })
          }
        }
      } else if (typeof rawContent === 'string' && rawContent) {
        messages.push({ role: 'user', content: rawContent, timestamp })
      }
    }
  }

  return messages
}

// 설정 변경이 클로저에 캡처되지 않도록 모듈 스코프에서 관리
let notificationsEnabled = true

function bindManagerToWindow(
  manager: RunManager,
  webContents: Electron.WebContents,
  sessions: Map<string, RunManager>,
  agentTracker: AgentTracker,
  getNotificationsEnabled: () => boolean,
): void {
  manager.on('text_chunk', (data) => webContents.send(IpcChannel.TEXT_CHUNK, data))
  manager.on('tool_call', (data) => webContents.send(IpcChannel.TOOL_CALL, data))
  manager.on('tool_result', (data) => webContents.send(IpcChannel.TOOL_RESULT, data))
  manager.on('permission_request', (data) => webContents.send(IpcChannel.PERMISSION_REQUEST, data))
  manager.on('turn_end', (data) => {
    webContents.send(IpcChannel.TURN_END, data)
    const win = BrowserWindow.fromWebContents(webContents)
    if (getNotificationsEnabled() && !win?.isFocused() && Notification.isSupported()) {
      new Notification({ title: 'Nexus Code', body: '작업이 완료되었습니다.' }).show()
    }
  })
  manager.on('session_end', (data) => {
    webContents.send(IpcChannel.SESSION_END, data)
    sessions.delete(data.sessionId)
    agentTracker.clearSession(data.sessionId)
  })
  manager.on('error', (data) => {
    logger.ipc.error('RunManager error', { data })
    webContents.send(IpcChannel.ERROR, data)
    const win = BrowserWindow.fromWebContents(webContents)
    if (getNotificationsEnabled() && !win?.isFocused() && Notification.isSupported()) {
      new Notification({ title: 'Nexus Code', body: '오류가 발생했습니다.' }).show()
    }
  })
  manager.on('restart_attempt', (data) => webContents.send(IpcChannel.RESTART_ATTEMPT, data))
  manager.on('restart_failed', (data) => webContents.send(IpcChannel.RESTART_FAILED, data))
  manager.on('timeout', (data) => webContents.send(IpcChannel.TIMEOUT, data))
  manager.on('rate_limit', (data) => webContents.send(IpcChannel.RATE_LIMIT, data))
  manager.on('status_change', (status: SessionStatus) => {
    webContents.send(IpcChannel.STATUS_CHANGE, {
      sessionId: manager.getSessionId(),
      status,
    } satisfies StatusChangeEvent)
  })
}

export function registerIpcHandlers(deps: IpcDeps): void {
  const { getWindow, sessions, hookServer, sessionManager, permissionHandler, agentTracker } = deps

  // ── SETTINGS_SYNC ─────────────────────────────────────────────────────────
  ipcMain.handle(IpcChannel.SETTINGS_SYNC, (_event, payload: { notificationsEnabled: boolean }) => {
    notificationsEnabled = payload.notificationsEnabled
  })

  // Renderer → Main: 퍼미션 응답
  ipcMain.handle(
    IpcChannel.RESPOND_PERMISSION,
    (_event, req: RespondPermissionRequest): RespondPermissionResponse => {
      const ok = permissionHandler.respond(req.requestId, req.approved, req.scope)
      return { ok }
    }
  )

  // ── START ────────────────────────────────────────────────────────────────
  ipcMain.handle(IpcChannel.START, async (_event, req: StartRequest): Promise<StartResponse> => {
    const manager = new RunManager()
    const win = getWindow()
    if (win) {
      bindManagerToWindow(manager, win.webContents, sessions, agentTracker, () => notificationsEnabled)
    }

    try {
      const settingsDir = join(req.cwd, '.claude')
      const settingsPath = join(settingsDir, 'settings.local.json')

      let settings: Record<string, unknown> = {}
      try {
        const existing = await readFile(settingsPath, 'utf8')
        settings = JSON.parse(existing) as Record<string, unknown>
      } catch { /* 파일 없음 또는 파싱 오류 */ }

      // 기존 훅에서 앱 관리 훅(PreToolUse, SubagentStart/Stop)을 제거하고 사용자 훅만 보존
      const existingHooks = (settings.hooks as Record<string, unknown> | undefined) ?? {}
      const { PreToolUse: _oldPre, SubagentStart: _oldStart, SubagentStop: _oldStop, ...userHooks } = existingHooks

      const subagentUrl = hookServer.subagentHookUrl()
      const subagentHook = [{
        matcher: '',
        hooks: [{
          type: 'command',
          command: `curl -sf -X POST '${subagentUrl}' -H 'Content-Type: application/json' -d @-`,
        }],
      }]

      const isBypass = req.permissionMode === 'bypassPermissions' || req.permissionMode === 'auto'
      if (!isBypass) {
        const hookUrl = hookServer.permissionHookUrl()
        settings.hooks = {
          ...userHooks,
          PreToolUse: [{
            matcher: '.*',
            hooks: [{
              type: 'command',
              command: `curl -sf -X POST '${hookUrl}' -H 'Content-Type: application/json' -d @- || exit 2`,
            }],
          }],
          SubagentStart: subagentHook,
          SubagentStop: subagentHook,
        }
      } else {
        // bypass 모드: PreToolUse 훅을 명시적으로 제거 (이전 세션 잔존 방지)
        settings.hooks = {
          ...userHooks,
          SubagentStart: subagentHook,
          SubagentStop: subagentHook,
        }
      }

      await mkdir(settingsDir, { recursive: true })
      await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8')

      const sessionId = await manager.start({
        prompt: req.prompt,
        cwd: req.cwd,
        model: req.model,
        effortLevel: req.effortLevel,
        permissionMode: req.permissionMode,
        sessionId: req.sessionId,
        images: req.images,
      })

      logger.ipc.info('session started', { sessionId, cwd: req.cwd, prompt: req.prompt.slice(0, 50), resume: !!req.sessionId })
      sessions.set(sessionId, manager)
      deps.pluginHost.setCwd(req.cwd, sessionId).catch((err) => logger.ipc.warn('PluginHost setCwd failed', { err }))

      return { sessionId }
    } catch (err) {
      logger.ipc.error('START failed', { err })
      throw err
    }
  })

  // ── PROMPT ───────────────────────────────────────────────────────────────
  ipcMain.handle(IpcChannel.PROMPT, (_event, req: PromptRequest): PromptResponse => {
    logger.ipc.debug('prompt sent', { sessionId: req.sessionId })
    const manager = sessions.get(req.sessionId)
    if (!manager) return { ok: false }
    return { ok: manager.sendPrompt(req.message, req.images) }
  })

  // ── CANCEL ───────────────────────────────────────────────────────────────
  ipcMain.handle(IpcChannel.CANCEL, (_event, req: CancelRequest): CancelResponse => {
    logger.ipc.info('cancel requested', { sessionId: req.sessionId })
    const manager = sessions.get(req.sessionId)
    if (!manager) return { ok: false }
    return { ok: manager.cancel() }
  })

  // ── STATUS ───────────────────────────────────────────────────────────────
  ipcMain.handle(IpcChannel.STATUS, (_event, req: StatusRequest): StatusResponse => {
    logger.ipc.debug('status requested', { sessionId: req.sessionId })
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
    const win = getWindow()
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

    logger.ipc.info('workspace added', { path: folderPath })
    return { workspace: { path: folderPath, name }, cancelled: false }
  })

  // ── WORKSPACE_REMOVE ─────────────────────────────────────────────────────
  ipcMain.handle(
    IpcChannel.WORKSPACE_REMOVE,
    async (_event, req: WorkspaceRemoveRequest): Promise<WorkspaceRemoveResponse> => {
      logger.ipc.info('workspace removed', { path: req.path })
      const workspaces = await readWorkspaces()
      const filtered = workspaces.filter((w) => w.path !== req.path)
      await writeWorkspaces(filtered)
      return { ok: true }
    }
  )

  // ── WORKSPACE_UPDATE_SESSION ──────────────────────────────────────────────
  ipcMain.handle(
    IpcChannel.WORKSPACE_UPDATE_SESSION,
    async (_event, req: WorkspaceUpdateSessionRequest): Promise<WorkspaceUpdateSessionResponse> => {
      const workspaces = await readWorkspaces()
      const entry = workspaces.find((w) => w.path === req.path)
      if (!entry) return { ok: false }
      entry.sessionId = req.sessionId
      await writeWorkspaces(workspaces)
      return { ok: true }
    }
  )

  // ── SETTINGS_READ ────────────────────────────────────────────────────────
  ipcMain.handle(IpcChannel.SETTINGS_READ, async (_event, req: ReadSettingsRequest): Promise<ReadSettingsResponse> => {
    const globalSettings = await readSettingsFile(globalSettingsPath())
    let projectSettings: ClaudeSettings = {}
    if (req?.workspacePath) {
      projectSettings = await readSettingsFile(projectSettingsPath(req.workspacePath))
    }
    return { global: globalSettings, project: projectSettings }
  })

  // ── SETTINGS_WRITE ───────────────────────────────────────────────────────
  ipcMain.handle(
    IpcChannel.SETTINGS_WRITE,
    async (_event, req: WriteSettingsRequest): Promise<WriteSettingsResponse> => {
      logger.ipc.debug('settings updated', { scope: req.scope })
      try {
        if (req.scope === 'global') {
          await writeSettingsFile(globalSettingsPath(), req.settings)
        } else if (req.workspacePath) {
          await writeSettingsFile(projectSettingsPath(req.workspacePath), req.settings)
        } else {
          logger.ipc.warn('project write without workspacePath')
        }
        return { ok: true }
      } catch (err) {
        logger.ipc.error('SETTINGS_WRITE failed', { err })
        return { ok: false }
      }
    }
  )

  // ── SETTINGS_DELETE_KEY ──────────────────────────────────────────────────
  ipcMain.handle(
    IpcChannel.SETTINGS_DELETE_KEY,
    async (_event, req: DeleteSettingsKeyRequest): Promise<DeleteSettingsKeyResponse> => {
      logger.ipc.debug('settings key deleted', { scope: req.scope, key: req.key })
      try {
        const filePath = req.scope === 'global'
          ? globalSettingsPath()
          : req.workspacePath ? projectSettingsPath(req.workspacePath) : null
        if (!filePath) return { ok: false }
        const existing = await readSettingsFile(filePath)
        delete (existing as Record<string, unknown>)[req.key]
        await mkdir(join(filePath, '..'), { recursive: true })
        await writeFile(filePath, JSON.stringify(existing, null, 2), 'utf8')
        return { ok: true }
      } catch (err) {
        logger.ipc.error('SETTINGS_DELETE_KEY failed', { err })
        return { ok: false }
      }
    }
  )

  // ── READ_FILE (MarkdownViewer용) ─────────────────────────────────────────
  ipcMain.handle(IpcChannel.READ_FILE, async (_event, req: { path: string; workspacePath: string }) => {
    try {
      // .md 파일만 허용
      if (!req.path.endsWith('.md')) {
        return { ok: false, error: 'Access denied: .md 파일만 허용됩니다' }
      }
      const resolved = path.resolve(req.path)
      const content = await readFile(resolved, 'utf8')
      return { ok: true, content }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // ── LOAD_HISTORY ─────────────────────────────────────────────────────────
  ipcMain.handle(
    IpcChannel.LOAD_HISTORY,
    async (_event, req: LoadHistoryRequest): Promise<LoadHistoryResponse> => {
      const filePath = await findSessionFile(req.sessionId)
      if (!filePath) return { ok: false, messages: [] }
      try {
        const messages = await parseSessionHistory(filePath)
        return { ok: true, messages }
      } catch (err) {
        logger.ipc.error('LOAD_HISTORY failed', { err, sessionId: req.sessionId })
        return { ok: false, messages: [] }
      }
    }
  )

  // ── CHECKPOINT_CREATE ────────────────────────────────────────────────────
  ipcMain.handle(
    IpcChannel.CHECKPOINT_CREATE,
    async (_event, req: CheckpointCreateRequest): Promise<CheckpointCreateResponse> => {
      const gitRepo = await isGitRepo(req.cwd)
      if (!gitRepo) return { ok: false, isGitRepo: false }
      try {
        const checkpoint = await createCheckpoint(req.cwd, req.sessionId, req.messageId)
        if (!checkpoint) return { ok: false, isGitRepo: true }
        return { ok: true, checkpoint, isGitRepo: true }
      } catch (err) {
        logger.ipc.error('CHECKPOINT_CREATE failed', { err, sessionId: req.sessionId })
        return { ok: false, isGitRepo: true }
      }
    }
  )

  // ── CHECKPOINT_RESTORE ───────────────────────────────────────────────────
  ipcMain.handle(
    IpcChannel.CHECKPOINT_RESTORE,
    async (_event, req: CheckpointRestoreRequest): Promise<CheckpointRestoreResponse> => {
      try {
        const { changedFiles, shortHash, untrackedFiles } = await restoreCheckpoint(req.cwd, req.checkpoint)
        return { ok: true, changedFiles, shortHash, untrackedFiles }
      } catch (err) {
        logger.ipc.error('CHECKPOINT_RESTORE failed', { err, sessionId: req.checkpoint.sessionId })
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  // ── GIT_CHECK ────────────────────────────────────────────────────────────
  ipcMain.handle(
    IpcChannel.GIT_CHECK,
    async (_event, req: GitCheckRequest): Promise<GitCheckResponse> => {
      const gitRepo = await isGitRepo(req.cwd)
      return { isGitRepo: gitRepo }
    }
  )

  // ── GIT_INIT ─────────────────────────────────────────────────────────────
  ipcMain.handle(
    IpcChannel.GIT_INIT,
    async (_event, req: GitInitRequest): Promise<GitInitResponse> => {
      try {
        await execFileAsync('git', ['init'], { cwd: req.cwd })
        return { ok: true }
      } catch (err) {
        logger.ipc.error('GIT_INIT failed', { err })
        return { ok: false }
      }
    }
  )

  // ── LOAD_SESSION (--resume) ───────────────────────────────────────────────
  ipcMain.handle(
    IpcChannel.LOAD_SESSION,
    async (_event, req: LoadSessionRequest): Promise<LoadSessionResponse> => {
      if (!req.sessionId) return { ok: false }

      const win = getWindow()
      const manager = new RunManager()
      if (win) {
        bindManagerToWindow(manager, win.webContents, sessions, agentTracker, () => notificationsEnabled)
      }

      const cwd = req.cwd ?? process.cwd()
      const sessionId = await manager.start({
        prompt: '',
        cwd,
        permissionMode: 'default',
        sessionId: req.sessionId,
      })
      sessions.set(sessionId, manager)
      deps.pluginHost.setCwd(cwd, sessionId).catch((err) => logger.ipc.warn('PluginHost setCwd failed', { err }))
      return { ok: true }
    }
  )


  // ── RESTART_SESSION ───────────────────────────────────────────────────────
  ipcMain.handle(
    IpcChannel.RESTART_SESSION,
    async (_event, req: RestartSessionRequest): Promise<RestartSessionResponse> => {
      logger.ipc.info('restart_session requested', { sessionId: req.sessionId, cwd: req.cwd })

      const existingManager = sessions.get(req.sessionId)
      if (existingManager) {
        // 기존 프로세스 종료 대기
        await existingManager.cancelAndWait()
        sessions.delete(req.sessionId)
      }

      const win = getWindow()
      const manager = new RunManager()
      if (win) {
        bindManagerToWindow(manager, win.webContents, sessions, agentTracker, () => notificationsEnabled)
      }

      try {
        // hooks 주입 (START 핸들러와 동일한 로직)
        const settingsDir = join(req.cwd, '.claude')
        const settingsPath = join(settingsDir, 'settings.local.json')

        let settings: Record<string, unknown> = {}
        try {
          const existing = await readFile(settingsPath, 'utf8')
          settings = JSON.parse(existing) as Record<string, unknown>
        } catch { /* 파일 없음 또는 파싱 오류 */ }

        // 기존 훅에서 앱 관리 훅을 제거하고 사용자 훅만 보존
        const existingHooks = (settings.hooks as Record<string, unknown> | undefined) ?? {}
        const { PreToolUse: _oldPre, SubagentStart: _oldStart, SubagentStop: _oldStop, ...userHooks } = existingHooks

        const subagentUrl = hookServer.subagentHookUrl()
        const subagentHook = [{
          matcher: '',
          hooks: [{
            type: 'command',
            command: `curl -sf -X POST '${subagentUrl}' -H 'Content-Type: application/json' -d @-`,
          }],
        }]

        const permissionMode: PermissionMode = (req.permissionMode ?? 'default') as PermissionMode
        const isBypass = permissionMode === 'bypassPermissions' || permissionMode === 'auto'
        if (!isBypass) {
          const hookUrl = hookServer.permissionHookUrl()
          settings.hooks = {
            ...userHooks,
            PreToolUse: [{
              matcher: '.*',
              hooks: [{
                type: 'command',
                command: `curl -sf -X POST '${hookUrl}' -H 'Content-Type: application/json' -d @- || exit 2`,
              }],
            }],
            SubagentStart: subagentHook,
            SubagentStop: subagentHook,
          }
        } else {
          // bypass 모드: PreToolUse 훅을 명시적으로 제거
          settings.hooks = {
            ...userHooks,
            SubagentStart: subagentHook,
            SubagentStop: subagentHook,
          }
        }

        await mkdir(settingsDir, { recursive: true })
        await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8')

        const newSessionId = await manager.start({
          prompt: '',
          cwd: req.cwd,
          model: req.model,
          effortLevel: req.effortLevel,
          permissionMode,
          sessionId: req.sessionId,
        })

        logger.ipc.info('session restarted', { newSessionId, cwd: req.cwd, resume: req.sessionId })
        sessions.set(newSessionId, manager)
        deps.pluginHost.setCwd(req.cwd, newSessionId).catch((err) => logger.ipc.warn('PluginHost setCwd failed', { err }))

        return { ok: true, sessionId: newSessionId }
      } catch (err) {
        logger.ipc.error('RESTART_SESSION failed', { err })
        return { ok: false }
      }
    }
  )

  // ── Nexus State (PluginHost 독립) ──────────────────────────────────────────

  const nexusWatchers = new Map<string, ReturnType<typeof watch>>()

  function readNexusState(cwd: string): NexusStateReadResponse {
    const stateDir = join(cwd, '.nexus', 'state')
    const readJson = (file: string): unknown => {
      const p = join(stateDir, file)
      try {
        if (!existsSync(p)) return null
        return JSON.parse(readFileSync(p, 'utf8'))
      } catch {
        return null
      }
    }
    return {
      consult: readJson('consult.json'),
      decisions: readJson('decisions.json'),
      tasks: readJson('tasks.json'),
    }
  }

  function watchNexusState(cwd: string): void {
    // 기존 watcher 정리
    const existing = nexusWatchers.get(cwd)
    if (existing) { try { existing.close() } catch {} }

    const stateDir = join(cwd, '.nexus', 'state')
    try {
      const watcher = watch(stateDir, (_event, filename) => {
        if (!filename?.endsWith('.json')) return
        const win = deps.getWindow()
        if (!win) return
        const data = readNexusState(cwd)
        win.webContents.send(IpcChannel.NEXUS_STATE_CHANGED, { cwd, ...data })
      })
      nexusWatchers.set(cwd, watcher)
    } catch {
      // .nexus/state/ 디렉토리 없으면 무시
      logger.ipc.debug('NexusState watch failed', { stateDir })
    }
  }

  ipcMain.handle(
    IpcChannel.NEXUS_STATE_READ,
    (_event, req: NexusStateReadRequest): NexusStateReadResponse => {
      // 읽기 + 감시 시작
      watchNexusState(req.cwd)
      return readNexusState(req.cwd)
    }
  )
}