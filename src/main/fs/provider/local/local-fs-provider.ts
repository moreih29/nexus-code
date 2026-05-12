import path from "node:path";
import type { DirEntry, FileReadResult, FsStat } from "../../../../shared/types/fs";
import { readdirCore, readFileCore, statCore } from "../../core/read-core";
import type { FsReadProvider } from "../types";

/**
 * Local read provider that authorizes workspace-relative paths before disk access.
 */
export class LocalFsProvider implements FsReadProvider {
  readonly kind = "local";
  readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
  }

  async readdir(relPath: string): Promise<DirEntry[]> {
    return readdirCore(this.resolveWorkspacePath(relPath));
  }

  async stat(relPath: string): Promise<FsStat> {
    return statCore(this.resolveWorkspacePath(relPath));
  }

  async readFile(relPath: string): Promise<FileReadResult> {
    return readFileCore(this.resolveWorkspacePath(relPath));
  }

  /**
   * Resolves a caller-provided path and rejects traversal outside the workspace root.
   */
  private resolveWorkspacePath(relPath: string): string {
    const abs = path.resolve(this.rootPath, relPath || ".");
    const rel = path.relative(this.rootPath, abs);

    if (rel === "" || rel === ".") {
      return abs;
    }
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("path escapes workspace root");
    }

    return abs;
  }
}
