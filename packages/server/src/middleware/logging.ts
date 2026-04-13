import type { MiddlewareHandler } from 'hono'
import type pino from 'pino'
import { createLogger } from '../logger.js'

/** Hono Variables 타입 — request-id + logger를 전체 앱 context에서 사용 가능하게 함 */
export type AppVariables = {
  requestId: string
  logger: pino.Logger
}

const baseLogger = createLogger('nexus-server')

export const loggingMiddleware: MiddlewareHandler = async (c, next) => {
  const start = Date.now()
  const { method, path } = c.req

  // request-id 미들웨어가 먼저 실행된 뒤 이 미들웨어가 실행됨이 보장됨 (app.ts 등록 순서).
  // requestId가 없는 경우(단독 테스트 등)에는 fallback으로 임시 ID 사용.
  const requestId = (c.get('requestId') as string | undefined) ?? crypto.randomUUID()
  const reqLogger = baseLogger.child({ requestId })
  c.set('logger', reqLogger)

  await next()

  const duration = Date.now() - start
  const status = c.res.status

  reqLogger.info({ method, path, status, duration }, `${method} ${path} ${status}`)
}

// baseLogger를 모듈 전체 fallback으로 export (error-boundary 등 미들웨어 외 코드에서 사용)
export { baseLogger as logger }
