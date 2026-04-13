import type { MiddlewareHandler } from 'hono'

/**
 * requestIdMiddleware — 요청마다 고유 ID를 생성해 context에 주입.
 * X-Request-Id 요청 헤더가 있으면 그대로 사용(클라이언트 발급 ID 전파),
 * 없으면 서버에서 randomUUID()로 생성.
 * 이후 미들웨어/핸들러는 c.get('requestId')로 접근하고,
 * 응답에 X-Request-Id 헤더로 echo-back한다.
 */
export const requestIdMiddleware: MiddlewareHandler = async (c, next) => {
  const requestId = c.req.header('x-request-id') ?? crypto.randomUUID()
  c.set('requestId', requestId)
  await next()
  c.res.headers.set('x-request-id', requestId)
}
