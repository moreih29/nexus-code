import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { loggingMiddleware } from './middleware/logging.js'
import { errorBoundary } from './middleware/error-boundary.js'
import { createHealthRouter } from './routes/health.js'
import { createWorkspaceRouter } from './routes/workspace.js'
import { createSessionRouter } from './routes/session.js'
import { createApprovalRouter } from './routes/approval.js'
import { createEventsRouter } from './routes/events.js'
import { createHooksRouter } from './routes/hooks.js'
import { createFilesRouter } from './routes/files.js'
import { createGitRouter } from './routes/git.js'
import { createSettingsRouter } from './routes/settings.js'
import { createCliSettingsRouter } from './routes/cli-settings.js'
import { WorkspaceRegistry } from './domain/workspace/workspace-registry.js'
import { ProcessSupervisor } from './adapters/cli/process-supervisor.js'
import { EventEmitterAdapter } from './adapters/events/event-emitter-adapter.js'
import { SessionStore } from './adapters/db/session-store.js'
import { WorkspaceStore } from './adapters/db/workspace-store.js'
import { ApprovalPolicyStore } from './adapters/db/approval-policy-store.js'
import { SettingsStore } from './adapters/db/settings-store.js'
import { HookManager } from './adapters/hooks/hook-manager.js'
import { ApprovalBridge } from './adapters/hooks/approval-bridge.js'
import { categorizeClaudeCodeTool } from './adapters/cli/tool-categorizer.js'
import { WorkspaceLogger } from './adapters/logging/workspace-logger.js'
import type { SessionRecord } from './routes/session.js'

export function createApp(port = Number(process.env['PORT'] ?? 3000)) {
  const dbPath = process.env['NEXUS_DB_PATH'] ?? join(homedir(), '.nexus-code', 'nexus.db')
  mkdirSync(dirname(dbPath), { recursive: true })

  const eventPort = new EventEmitterAdapter()
  const registry = new WorkspaceRegistry(eventPort)
  const supervisor = new ProcessSupervisor()
  const sessions = new Map<string, SessionRecord>()
  const store = new SessionStore(dbPath)
  const workspaceStore = new WorkspaceStore(store.db)
  const policyStore = new ApprovalPolicyStore(store.db)
  const settingsStore = new SettingsStore(store.db)
  const hookManager = new HookManager(port)
  const approvalBridge = new ApprovalBridge(policyStore, settingsStore, categorizeClaudeCodeTool)
  const workspaceLogger = new WorkspaceLogger()

  const workspaceRows = workspaceStore.list()
  for (const row of workspaceRows) {
    registry.add({ id: row.id, path: row.path, name: row.name ?? undefined })
  }

  hookManager.cleanupOrphanHooks(workspaceRows.map((r) => r.path)).catch(() => {
    // Best-effort cleanup — do not block startup
  })

  const app = new Hono()

  app.use('*', cors())
  app.use('*', loggingMiddleware)
  app.onError(errorBoundary)

  app.route('/api/health', createHealthRouter(hookManager))
  app.route('/api/workspaces', createWorkspaceRouter(registry, workspaceStore))
  app.route('/api/sessions', createSessionRouter(supervisor, registry, sessions, store, hookManager, settingsStore, workspaceLogger, policyStore))
  app.route('/api/approvals', createApprovalRouter(approvalBridge, policyStore, workspaceLogger))
  app.route('/api/workspaces', createEventsRouter(supervisor, approvalBridge, workspaceLogger))
  app.route('/api/workspaces', createFilesRouter())
  app.route('/api/workspaces', createGitRouter())
  app.route('/api/settings', createSettingsRouter(settingsStore))
  app.route('/api/cli-settings', createCliSettingsRouter())
  app.route('/hooks', createHooksRouter(hookManager, approvalBridge, workspaceLogger))

  return { app, supervisor, registry, store, hookManager, workspaceLogger }
}
