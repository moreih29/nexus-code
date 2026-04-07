import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { createLogger } from './logger.js'

const logger = createLogger('nexus-server')
const PORT = Number(process.env['PORT'] ?? 3000)

const { app, supervisor, registry: _registry, store, hookManager } = createApp(PORT)

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  logger.info({ port: info.port }, `Server listening on port ${info.port}`)
})

async function shutdown() {
  logger.info('Shutting down...')
  await hookManager.removeAllHooks()
  supervisor.dispose()
  store.close()
  server.close()
}

process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
