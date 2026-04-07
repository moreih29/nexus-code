import pino from 'pino'

const isDev = process.env['NODE_ENV'] !== 'production'

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
