import { ipcMain, dialog, BrowserWindow } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir, readdir, access } from 'fs/promises'
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
  ReadSettingsResponse,
  WriteSettingsRequest,
  WriteSettingsResponse,
  LoadHistoryRequest,
  LoadHistoryResponse,
  HistoryMessage,
  CheckpointCreateRequest,
  CheckpointCreateResponse,
  CheckpointRestoreRequest,
  CheckpointRestoreResponse,
  CheckpointListRequest,
  CheckpointListResponse,
  GitCheckRequest,
  GitCheckResponse,
  GitInitRequest,
  GitInitResponse,
} from '../../shared/types'
import { RunManager } from '../control-plane/run-manager'
import { HookServer } from '../control-plane/hook-server'
import { SessionManager } from '../control-plane/session-manager'
import { PermissionHandler } from '../control-plane/permission-handler'
import { PluginHost } from '../plugin-host'
import { isGitRepo, createCheckpoint, restoreCheckpoint, listCheckpoints } from '../control-plane/checkpoint-manager'
import log from '../logger'

export interface IpcDeps {
  getWindow: () => BrowserWindow | null
  sessions: Map<string, RunManager>
  hookServer: HookServer
  sessionManager: SessionManager
  permissionHandler: PermissionHandler
  pluginHost: PluginHost
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
  return join(cwd, '.claude', 'settings.json')
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

export function registerIpcHandlers(deps: IpcDeps): void {
  const { getWindow, sessions, hookServer, sessionManager, permissionHandler } = deps

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

    manager.on('text_chunk', (data) => win?.webContents.send(IpcChannel.TEXT_CHUNK, data))
    manager.on('tool_call', (data) => win?.webContents.send(IpcChannel.TOOL_CALL, data))
    manager.on('tool_result', (data) => win?.webContents.send(IpcChannel.TOOL_RESULT, data))
    manager.on('permission_request', (data) =>
      win?.webContents.send(IpcChannel.PERMISSION_REQUEST, data)
    )
    manager.on('turn_end', (data) => win?.webContents.send(IpcChannel.TURN_END, data))
    manager.on('session_end', (data) => {
      win?.webContents.send(IpcChannel.SESSION_END, data)
      sessions.delete(data.sessionId)
    })
    manager.on('error', (data) => {
      log.error('[RunManager error]', data)
      win?.webContents.send(IpcChannel.ERROR, data)
    })
    manager.on('restart_attempt', (data) => win?.webContents.send(IpcChannel.RESTART_ATTEMPT, data))
    manager.on('restart_failed', (data) => win?.webContents.send(IpcChannel.RESTART_FAILED, data))
    manager.on('timeout', (data) => win?.webContents.send(IpcChannel.TIMEOUT, data))
    manager.on('rate_limit', (data) => win?.webContents.send(IpcChannel.RATE_LIMIT, data))

    try {
      if (req.permissionMode !== 'auto') {
        const hookUrl = hookServer.permissionHookUrl()
        const settingsDir = join(req.cwd, '.claude')
        const settingsPath = join(settingsDir, 'settings.local.json')

        let settings: Record<string, unknown> = {}
        try {
          const existing = await readFile(settingsPath, 'utf8')
          settings = JSON.parse(existing) as Record<string, unknown>
        } catch { /* 파일 없음 또는 파싱 오류 */ }

        const existingHooks = (settings.hooks as Record<string, unknown> | undefined) ?? {}
        settings.hooks = {
          ...existingHooks,
          PreToolUse: [{
            matcher: '.*',
            hooks: [{
              type: 'command',
              command: `curl -sf -X POST '${hookUrl}' -H 'Content-Type: application/json' -d @-`,
            }],
          }],
        }

        await mkdir(settingsDir, { recursive: true })
        await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8')
      }

      const sessionId = await manager.start({
        prompt: req.prompt,
        cwd: req.cwd,
        permissionMode: req.permissionMode,
        sessionId: req.sessionId,
      })

      log.info('[START]', { sessionId, cwd: req.cwd, prompt: req.prompt.slice(0, 50), resume: !!req.sessionId })
      sessions.set(sessionId, manager)

      // git 저장소이면 체크포인트 자동 생성 (새 세션 + resume 모두)
      let checkpoint
      if (await isGitRepo(req.cwd)) {
        try {
          checkpoint = await createCheckpoint(req.cwd, sessionId)
        } catch (err) {
          log.warn('[START] 체크포인트 생성 실패', err)
        }
      }

      return { sessionId, checkpoint: checkpoint ?? undefined }
    } catch (err) {
      log.error('[START failed]', err)
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
  ipcMain.handle(IpcChannel.SETTINGS_READ, async (): Promise<ReadSettingsResponse> => {
    const workspaces = await readWorkspaces()
    const activeWorkspace = workspaces.find((w) => w.sessionId) ?? workspaces[0]
    const globalSettings = await readSettingsFile(globalSettingsPath())
    const projectSettings = activeWorkspace
      ? await readSettingsFile(projectSettingsPath(activeWorkspace.path))
      : {}
    return { global: globalSettings, project: projectSettings }
  })

  // ── SETTINGS_WRITE ───────────────────────────────────────────────────────
  ipcMain.handle(
    IpcChannel.SETTINGS_WRITE,
    async (_event, req: WriteSettingsRequest): Promise<WriteSettingsResponse> => {
      try {
        if (req.scope === 'global') {
          await writeSettingsFile(globalSettingsPath(), req.settings)
        } else {
          const workspaces = await readWorkspaces()
          const activeWorkspace = workspaces.find((w) => w.sessionId) ?? workspaces[0]
          if (activeWorkspace) {
            await writeSettingsFile(projectSettingsPath(activeWorkspace.path), req.settings)
          }
        }
        return { ok: true }
      } catch (err) {
        log.error('[SETTINGS_WRITE]', err)
        return { ok: false }
      }
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
        log.error('[LOAD_HISTORY]', err)
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
        const checkpoint = await createCheckpoint(req.cwd, req.sessionId)
        if (!checkpoint) return { ok: false, isGitRepo: true }
        return { ok: true, checkpoint, isGitRepo: true }
      } catch (err) {
        log.error('[CHECKPOINT_CREATE]', err)
        return { ok: false, isGitRepo: true }
      }
    }
  )

  // ── CHECKPOINT_RESTORE ───────────────────────────────────────────────────
  ipcMain.handle(
    IpcChannel.CHECKPOINT_RESTORE,
    async (_event, req: CheckpointRestoreRequest): Promise<CheckpointRestoreResponse> => {
      try {
        await restoreCheckpoint(req.cwd, req.checkpoint)
        return { ok: true }
      } catch (err) {
        log.error('[CHECKPOINT_RESTORE]', err)
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  // ── CHECKPOINT_LIST ──────────────────────────────────────────────────────
  ipcMain.handle(
    IpcChannel.CHECKPOINT_LIST,
    async (_event, req: CheckpointListRequest): Promise<CheckpointListResponse> => {
      try {
        const checkpoints = await listCheckpoints(req.cwd, req.sessionId)
        return { ok: true, checkpoints }
      } catch (err) {
        log.error('[CHECKPOINT_LIST]', err)
        return { ok: false, checkpoints: [] }
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
        log.error('[GIT_INIT]', err)
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

      manager.on('text_chunk', (data) => win?.webContents.send(IpcChannel.TEXT_CHUNK, data))
      manager.on('tool_call', (data) => win?.webContents.send(IpcChannel.TOOL_CALL, data))
      manager.on('tool_result', (data) => win?.webContents.send(IpcChannel.TOOL_RESULT, data))
      manager.on('permission_request', (data) =>
        win?.webContents.send(IpcChannel.PERMISSION_REQUEST, data)
      )
      manager.on('turn_end', (data) => win?.webContents.send(IpcChannel.TURN_END, data))
      manager.on('session_end', (data) => {
        win?.webContents.send(IpcChannel.SESSION_END, data)
        sessions.delete(data.sessionId)
      })
      manager.on('error', (data) => win?.webContents.send(IpcChannel.ERROR, data))
      manager.on('restart_attempt', (data) => win?.webContents.send(IpcChannel.RESTART_ATTEMPT, data))
      manager.on('restart_failed', (data) => win?.webContents.send(IpcChannel.RESTART_FAILED, data))
      manager.on('timeout', (data) => win?.webContents.send(IpcChannel.TIMEOUT, data))
      manager.on('rate_limit', (data) => win?.webContents.send(IpcChannel.RATE_LIMIT, data))

      const sessionId = await manager.start({
        prompt: '',
        cwd: process.cwd(),
        permissionMode: 'manual',
        sessionId: req.sessionId,
      })
      sessions.set(sessionId, manager)
      return { ok: true }
    }
  )
}
