import type { Result } from '@nexus/shared'

export interface StoragePort {
  read(path: string): Promise<Result<string>>
  write(path: string, content: string): Promise<Result<void>>
}
