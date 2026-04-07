import { type Result, type AppError, ok, err, appError } from '@nexus/shared'
import type { StoragePort } from '../../ports/storage-port.js'

type WriteTask = () => Promise<void>

export class SettingsManager {
  private _cache: Map<string, unknown>
  private _storage: StoragePort
  private _storagePath: string
  private _writeQueue: Promise<void>

  constructor(storage: StoragePort, storagePath: string) {
    this._cache = new Map()
    this._storage = storage
    this._storagePath = storagePath
    this._writeQueue = Promise.resolve()
  }

  async load(): Promise<Result<void, AppError>> {
    const result = await this._storage.read(this._storagePath)
    if (!result.ok) {
      // No existing settings file is acceptable — start with empty cache
      if (result.error.code === 'FILE_NOT_FOUND') {
        return ok(undefined)
      }
      return err(result.error)
    }
    try {
      const parsed = JSON.parse(result.value) as Record<string, unknown>
      for (const [key, value] of Object.entries(parsed)) {
        this._cache.set(key, value)
      }
      return ok(undefined)
    } catch (cause) {
      return err(appError('SETTINGS_PARSE_ERROR', 'Failed to parse settings JSON', { cause }))
    }
  }

  get<T = unknown>(key: string): Result<T, AppError> {
    if (!this._cache.has(key)) {
      return err(appError('SETTING_NOT_FOUND', `Setting '${key}' not found`))
    }
    return ok(this._cache.get(key) as T)
  }

  set(key: string, value: unknown): Promise<Result<void, AppError>> {
    this._cache.set(key, value)

    // Enqueue the write so concurrent calls are serialized
    const writeResult = new Promise<Result<void, AppError>>((resolve) => {
      this._writeQueue = this._writeQueue.then(async () => {
        const serialized = JSON.stringify(Object.fromEntries(this._cache), null, 2)
        const result = await this._storage.write(this._storagePath, serialized)
        resolve(result)
      })
    })

    return writeResult
  }
}
