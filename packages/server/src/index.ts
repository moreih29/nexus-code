import { createApp } from './app.js'
import { createLogger } from './logger.js'

const logger = createLogger('nexus-server')
const PORT = Number(process.env['PORT'] ?? 3000)

const { app, supervisor, registry: _registry, store, hookManager } = createApp(PORT)

// Bun 런타임 기반 sidecar 패턴 (Phase 2: tauri shell sidecar로 배포)
const server = Bun.serve({ fetch: app.fetch, port: PORT })
logger.info({ port: server.port }, `Server listening on port ${server.port}`)

async function shutdown() {
  logger.info('Shutting down...')
  await hookManager.removeAllHooks()
  supervisor.dispose()
  store.close()
  server.stop()
}

process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
