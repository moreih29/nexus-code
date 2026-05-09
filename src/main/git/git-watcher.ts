/**
 * Git-specific filesystem watcher that turns repository metadata changes into
 * per-workspace dirty signals for status refresh scheduling.
 */
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";

export type GitDirtyCallback = (workspaceId: string) => void;

interface GitWatchEntry {
  readonly workspaceId: string;
  readonly gitDir: string;
  readonly watcher: FSWatcher;
}

const IGNORED_TOP_LEVEL_DIRS = new Set(["objects", "logs"]);

/**
 * Maintains one chokidar watcher per workspace/repository `.git` directory.
 */
export class GitWatcher {
  private readonly entries = new Map<string, GitWatchEntry>();
  private readonly onDirty: GitDirtyCallback;

  constructor(onDirty: GitDirtyCallback) {
    this.onDirty = onDirty;
  }

  /**
   * Starts watching a repository's `.git` directory for status-relevant files.
   */
  watch(workspaceId: string, gitDir: string): void {
    const absGitDir = path.resolve(gitDir);
    const existing = this.entries.get(workspaceId);
    if (existing?.gitDir === absGitDir) {
      return;
    }

    if (existing) {
      this.disposeWorkspace(workspaceId);
    }

    const watcher = chokidar.watch(absGitDir, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: false,
      ignored: (p: string) => isIgnoredGitWatchPath(absGitDir, p),
    });

    const handleDirty = (changedPath: string): void => {
      if (isIgnoredGitWatchPath(absGitDir, changedPath)) {
        return;
      }
      this.onDirty(workspaceId);
    };

    watcher.on("add", handleDirty);
    watcher.on("change", handleDirty);
    watcher.on("unlink", handleDirty);

    this.entries.set(workspaceId, { workspaceId, gitDir: absGitDir, watcher });
  }

  /**
   * Stops watching the repository metadata for one workspace.
   */
  unwatch(workspaceId: string): void {
    this.disposeWorkspace(workspaceId);
  }

  /**
   * Closes and forgets the watcher for a removed or re-detected workspace.
   */
  disposeWorkspace(workspaceId: string): void {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      return;
    }

    void entry.watcher.close();
    this.entries.delete(workspaceId);
  }

  /**
   * Closes every Git watcher owned by this process.
   */
  dispose(): void {
    for (const entry of this.entries.values()) {
      void entry.watcher.close();
    }
    this.entries.clear();
  }
}

/**
 * Filters noisy Git internals that do not change the Source Control status.
 */
export function isIgnoredGitWatchPath(gitDir: string, candidatePath: string): boolean {
  const basename = path.basename(candidatePath);
  if (basename.endsWith(".lock")) {
    return true;
  }

  const relativePath = path.relative(gitDir, candidatePath);
  if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return false;
  }

  const [topLevelName] = relativePath.split(path.sep);
  return topLevelName !== undefined && IGNORED_TOP_LEVEL_DIRS.has(topLevelName);
}
