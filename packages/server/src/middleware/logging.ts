import type { MiddlewareHandler } from 'hono'
import { createLogger } from '../logger.js'

const logger = createLogger('nexus-server')

export const loggingMiddleware: MiddlewareHandler = async (c, next) => {
  const start = Date.now()
  const { method, path } = c.req

  await next()

  const duration = Date.now() - start
  const status = c.res.status

  logger.info({ method, path, status, duration }, `${method} ${path} ${status}`)
}

export { logger }
