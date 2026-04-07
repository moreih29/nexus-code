export interface AppError {
  code: string
  message: string
  cause?: unknown
  severity: 'recoverable' | 'fatal'
}

export function appError(
  code: string,
  message: string,
  opts?: { cause?: unknown; severity?: 'recoverable' | 'fatal' }
): AppError {
  return {
    code,
    message,
    cause: opts?.cause,
    severity: opts?.severity ?? 'recoverable',
  }
}
