/**
 * Per-entry actions invoked from the Source Control row context menu.
 *
 * These take a `GitStatusEntry` and decide where to send the click — opening
 * a diff view, revealing in the OS shell, copying paths, or appending to
 * `.gitignore`. They were inlined inside `GitPanel.tsx`; extracting them
 * keeps the panel component focused on layout, draft state, and dialog
 * orchestration while these utilities live next to the helper modules
 * they delegate into.
 */
import type { GitExpandedGroupKey, GitStatusEntry } from "../../../../../shared/types/git";
import { ipcCall } from "../../../../ipc/client";
import { openOrRevealEditor } from "../../../../services/editor";
import { copyText } from "../../../../utils/clipboard";
import type { GitPanelOpenDiffInput } from "./git-panel";

export type EntryActionBanner = { variant: "info" | "error"; message: string };

export interface EntryActionContext {
  readonly workspaceId: string;
  /** Repository topLevel when detected, falling back to the workspace root. */
  readonly repoPath: string | undefined;
  readonly workspaceRootPath: string | undefined;
  readonly onOpenDiff: ((input: GitPanelOpenDiffInput) => void) | undefined;
  readonly setBanner: (banner: EntryActionBanner) => void;
}

export interface EntryActions {
  openChanges(entry: GitStatusEntry, groupKey: GitExpandedGroupKey): void;
  absolutePathForEntry(entry: GitStatusEntry): string | null;
  openWorkingTreeFile(entry: GitStatusEntry): void;
  revealEntryInOS(entry: GitStatusEntry): void;
  copyEntryPath(entry: GitStatusEntry): void;
  copyEntryRelativePath(entry: GitStatusEntry): void;
  addEntryToGitignore(entry: GitStatusEntry): void;
  addPathsToGitignore(paths: string[]): Promise<void>;
}

/**
 * Builds the bound entry-action handlers for one panel render. Recomputing
 * on workspace/repoPath change is cheap — these are plain closures, not
 * memoized React state.
 */
export function createEntryActions(ctx: EntryActionContext): EntryActions {
  function absolutePathForEntry(entry: GitStatusEntry): string | null {
    const root = ctx.repoPath ?? ctx.workspaceRootPath;
    if (!root) return null;
    return joinRootAndGitRelPath(root, entry.relPath);
  }

  function openChanges(entry: GitStatusEntry, groupKey: GitExpandedGroupKey): void {
    // Conflict entries (unmerged) contain conflict markers in the working tree.
    // Opening them as a diff would hit INDEX stage-0 which does not exist for
    // unmerged files. Instead, open the working-tree file in the in-app editor
    // so the user can edit conflict markers directly.
    if (entry.conflictType !== null) {
      const absPath = absolutePathForEntry(entry);
      if (!absPath) {
        ctx.setBanner({ variant: "error", message: "Working tree path is unavailable." });
        return;
      }
      openOrRevealEditor({ workspaceId: ctx.workspaceId, filePath: absPath });
      return;
    }

    if (ctx.onOpenDiff) {
      ctx.onOpenDiff({ workspaceId: ctx.workspaceId, groupKey, entry });
      return;
    }
    ctx.setBanner({ variant: "info", message: "Diff view를 사용할 수 없습니다" });
  }

  function openWorkingTreeFile(entry: GitStatusEntry): void {
    const absPath = absolutePathForEntry(entry);
    if (!absPath) {
      ctx.setBanner({ variant: "error", message: "Working tree path is unavailable." });
      return;
    }
    void runSystemPathAction("openPathExternal", absPath, ctx.setBanner);
  }

  function revealEntryInOS(entry: GitStatusEntry): void {
    const absPath = absolutePathForEntry(entry);
    if (!absPath) {
      ctx.setBanner({ variant: "error", message: "Working tree path is unavailable." });
      return;
    }
    void runSystemPathAction("revealInOS", absPath, ctx.setBanner);
  }

  function copyEntryPath(entry: GitStatusEntry): void {
    const absPath = absolutePathForEntry(entry);
    if (!absPath) return;
    copyText(absPath);
  }

  function copyEntryRelativePath(entry: GitStatusEntry): void {
    copyText(entry.relPath);
  }

  async function addPathsToGitignore(paths: string[]): Promise<void> {
    const uniquePaths = Array.from(new Set(paths));
    if (uniquePaths.length === 0) return;

    try {
      const results = [];
      for (const relPath of uniquePaths) {
        results.push(await ipcCall("git", "addToGitignore", { workspaceId: ctx.workspaceId, relPath }));
      }
      const addedCount = results.filter((result) => result.added).length;
      ctx.setBanner({
        variant: "info",
        message:
          addedCount > 0
            ? `Added ${addedCount} path${addedCount === 1 ? "" : "s"} to .gitignore.`
            : "Already in .gitignore.",
      });
    } catch (error) {
      ctx.setBanner({
        variant: "error",
        message: error instanceof Error ? error.message : "Could not update .gitignore.",
      });
    }
  }

  function addEntryToGitignore(entry: GitStatusEntry): void {
    void addPathsToGitignore([entry.relPath]);
  }

  return {
    openChanges,
    absolutePathForEntry,
    openWorkingTreeFile,
    revealEntryInOS,
    copyEntryPath,
    copyEntryRelativePath,
    addEntryToGitignore,
    addPathsToGitignore,
  };
}

/**
 * Joins a repository/workspace root with Git's slash-separated relPath while
 * preserving the host path separator for copied absolute paths.
 */
function joinRootAndGitRelPath(rootPath: string, relPath: string): string {
  const separator = rootPath.includes("\\") && !rootPath.includes("/") ? "\\" : "/";
  const normalizedRoot = rootPath.replace(/[\\/]+$/, "");
  const normalizedRelPath = relPath.split("/").join(separator);
  return `${normalizedRoot}${separator}${normalizedRelPath}`;
}

/**
 * Runs one of the system path IPC calls and maps typed failures into the
 * inline Git banner instead of throwing from a fire-and-forget menu action.
 */
async function runSystemPathAction(
  method: "openPathExternal" | "revealInOS",
  absPath: string,
  setBanner: (banner: EntryActionBanner) => void,
): Promise<void> {
  try {
    const result = await ipcCall("system", method, { absPath });
    if (!result.ok) {
      setBanner({ variant: "error", message: result.error.message });
    }
  } catch (error) {
    setBanner({
      variant: "error",
      message: error instanceof Error ? error.message : "System path action failed.",
    });
  }
}
