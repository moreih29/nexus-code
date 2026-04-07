import type { ErrorHandler } from 'hono'
import type { AppError } from '@nexus/shared'
import { logger } from './logging.js'

function isAppError(value: unknown): value is AppError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'message' in value &&
    'severity' in value
  )
}

function statusFromAppError(err: AppError): number {
  if (err.severity === 'fatal') return 500
  switch (err.code) {
    case 'NOT_FOUND':
      return 404
    case 'UNAUTHORIZED':
      return 401
    case 'FORBIDDEN':
      return 403
    case 'CONFLICT':
      return 409
    case 'VALIDATION_ERROR':
      return 400
    default:
      return 500
  }
}

export const errorBoundary: ErrorHandler = (err, c) => {
  if (isAppError(err)) {
    const status = statusFromAppError(err)
    logger.error({ code: err.code, severity: err.severity }, err.message)
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
        },
      },
      status as Parameters<typeof c.json>[1]
    )
  }

  logger.error({ err }, 'Unhandled error')
  return c.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    },
    500
  )
}
