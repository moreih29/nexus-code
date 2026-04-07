import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ok, err, appError } from '@nexus/shared'
import type { Result } from '@nexus/shared'
import type { StoragePort } from '../../ports/storage-port.js'

export class FsStorageAdapter implements StoragePort {
  async read(path: string): Promise<Result<string>> {
    try {
      const content = await readFile(path, 'utf8')
      return ok(content)
    } catch (cause) {
      return err(appError('STORAGE_READ_ERROR', `Failed to read file at '${path}'`, { cause }))
    }
  }

  async write(path: string, content: string): Promise<Result<void>> {
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, 'utf8')
      return ok(undefined)
    } catch (cause) {
      return err(appError('STORAGE_WRITE_ERROR', `Failed to write file at '${path}'`, { cause }))
    }
  }
}
