import type { MiddlewareHandler } from 'hono'
import { type ZodType, type ZodError, type ZodIssue } from 'zod'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function validateBody<T>(schema: ZodType<T>): MiddlewareHandler<{ Variables: { validatedBody: any } }> {
  return async (c, next) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(
        {
          error: {
            code: 'INVALID_JSON',
            message: 'Request body must be valid JSON',
          },
        },
        400
      )
    }

    const result = schema.safeParse(body)
    if (!result.success) {
      const zodError = result.error as ZodError
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request validation failed',
            issues: zodError.issues.map((i: ZodIssue) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
        },
        400
      )
    }

    c.set('validatedBody', result.data)
    await next()
  }
}
