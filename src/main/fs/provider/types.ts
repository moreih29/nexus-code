import type { DirEntry, FileReadResult, FsStat } from "../../../shared/types/fs";

/**
 * Read-only filesystem provider bound to a workspace location.
 */
export interface FsReadProvider {
  readonly kind: "local" | "ssh";
  readdir(relPath: string): Promise<DirEntry[]>;
  stat(relPath: string): Promise<FsStat>;
  readFile(relPath: string): Promise<FileReadResult>;
}
