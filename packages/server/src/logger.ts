import pino from 'pino'

// Bun `--compile` single-file executable 내에서는 pino-pretty worker의 dynamic
// require가 실패(crash)한다. 번들 실행 환경(`/$bunfs/`)을 감지해 transport 자체를 비활성.
const isBundled = import.meta.url.startsWith('file:///$bunfs/')
const isDev = process.env['NODE_ENV'] !== 'production' && !isBundled

export function createLogger(name?: string) {
  return pino(
    {
      name,
      level: process.env['LOG_LEVEL'] ?? 'info',
    },
    isDev
      ? pino.transport({
          target: 'pino-pretty',
          options: { colorize: true },
        })
      : undefined
  )
}

export function createChildLogger(
  parent: pino.Logger,
  bindings: Record<string, string>
) {
  return parent.child(bindings)
}
