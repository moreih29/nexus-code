import { stat } from 'node:fs/promises'
import path from 'node:path'
import { ok, err, appError } from '@nexus/shared'
import type { Result } from '@nexus/shared'

export async function validateWorkspacePath(inputPath: string): Promise<Result<string>> {
  if (!path.isAbsolute(inputPath)) {
    return err(appError('INVALID_PATH', 'Path must be absolute'))
  }

  const resolved = path.resolve(inputPath)

  try {
    const stats = await stat(resolved)
    if (!stats.isDirectory()) {
      return err(appError('INVALID_PATH', 'Path is not a directory'))
    }
  } catch {
    return err(appError('INVALID_PATH', 'Path does not exist'))
  }

  return ok(resolved)
}
