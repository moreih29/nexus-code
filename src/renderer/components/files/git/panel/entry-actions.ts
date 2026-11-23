import i18next from "i18next";
import { toNativeDrivePath } from "../../../../../shared/fs/drive-path";
import type { GitExpandedGroupKey, GitStatusEntry } from "../../../../../shared/git/types";
import { ipcCallResult, unwrapGitResult } from "../../../../ipc/client";
import { openOrRevealEditor } from "../../../../services/editor";
import { copyText } from "../../../../utils/clipboard";
import type { GitPanelOpenDiffInput } from "./panel";

export type EntryActionBanner = { variant: "info" | "error"; message: string };

export interface EntryActionContext {
  readonly workspaceId: string;
  readonly repoPath: string | undefined;
  readonly workspaceRootPath: string | undefined;
  readonly onOpenDiff: ((input: GitPanelOpenDiffInput) => void) | undefined;
  readonly setBanner: (banner: EntryActionBanner) => void;
}

export interface EntryActions {
  openChanges(
    entry: GitStatusEntry,
    groupKey: GitExpandedGroupKey,
    opts?: { preview: boolean },
  ): void;
  absolutePathForEntry(entry: GitStatusEntry): string | null;
  openWorkingTreeFile(entry: GitStatusEntry): void;
  revealEntryInOS(entry: GitStatusEntry): void;
  copyEntryPath(entry: GitStatusEntry): void;
  copyEntryRelativePath(entry: GitStatusEntry): void;
  addEntryToGitignore(entry: GitStatusEntry): void;
  addPathsToGitignore(paths: string[]): Promise<void>;
}

export function createEntryActions(ctx: EntryActionContext): EntryActions {
  function absolutePathForEntry(entry: GitStatusEntry): string | null {
    const root = ctx.repoPath ?? ctx.workspaceRootPath;
    if (!root) return null;
    return joinRootAndGitRelPath(root, entry.relPath);
  }

  function openChanges(
    entry: GitStatusEntry,
    groupKey: GitExpandedGroupKey,
    opts?: { preview: boolean },
  ): void {
    if (entry.conflictType !== null) {
      const absPath = absolutePathForEntry(entry);
      if (!absPath) {
        ctx.setBanner({
          variant: "error",
          message: i18next.t("files:git.entryActions.workingTreeUnavailable"),
        });
        return;
      }
      openOrRevealEditor({ workspaceId: ctx.workspaceId, filePath: absPath });
      return;
    }

    if (ctx.onOpenDiff) {
      ctx.onOpenDiff({
        workspaceId: ctx.workspaceId,
        groupKey,
        entry,
        ...(opts ? { preview: opts.preview } : {}),
      });
      return;
    }
    ctx.setBanner({
      variant: "info",
      message: i18next.t("files:git.entryActions.diffViewUnavailable"),
    });
  }

  function openWorkingTreeFile(entry: GitStatusEntry): void {
    const absPath = absolutePathForEntry(entry);
    if (!absPath) {
      ctx.setBanner({
        variant: "error",
        message: i18next.t("files:git.entryActions.workingTreeUnavailable"),
      });
      return;
    }
    openOrRevealEditor({ workspaceId: ctx.workspaceId, filePath: absPath });
  }

  function revealEntryInOS(entry: GitStatusEntry): void {
    const absPath = absolutePathForEntry(entry);
    if (!absPath) {
      ctx.setBanner({
        variant: "error",
        message: i18next.t("files:git.entryActions.workingTreeUnavailable"),
      });
      return;
    }
    void runSystemPathAction("revealInOS", absPath, ctx.setBanner);
  }

  function copyEntryPath(entry: GitStatusEntry): void {
    const absPath = absolutePathForEntry(entry);
    if (!absPath) return;
    copyText(toNativeDrivePath(absPath));
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
        results.push(
          unwrapGitResult(
            await ipcCallResult("git", "addToGitignore", { workspaceId: ctx.workspaceId, relPath }),
          ),
        );
      }
      const addedCount = results.filter((result) => result.added).length;
      ctx.setBanner({
        variant: "info",
        message:
          addedCount > 0
            ? i18next.t("files:git.entryActions.addedToGitignore", { count: addedCount })
            : i18next.t("files:git.entryActions.alreadyInGitignore"),
      });
    } catch (error) {
      ctx.setBanner({
        variant: "error",
        message:
          error instanceof Error
            ? error.message
            : i18next.t("files:git.entryActions.couldNotUpdateGitignore"),
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

function joinRootAndGitRelPath(rootPath: string, relPath: string): string {
  const separator = rootPath.includes("\\") && !rootPath.includes("/") ? "\\" : "/";
  const normalizedRoot = rootPath.replace(/[\\/]+$/, "");
  const normalizedRelPath = relPath.split("/").join(separator);
  return `${normalizedRoot}${separator}${normalizedRelPath}`;
}

async function runSystemPathAction(
  method: "revealInOS",
  absPath: string,
  setBanner: (banner: EntryActionBanner) => void,
): Promise<void> {
  const result = await ipcCallResult("system", method, { absPath });
  if (result.ok) {
    const inner = result.value as { ok: boolean; error?: { message: string } };
    if (!inner.ok) {
      setBanner({
        variant: "error",
        message: inner.error?.message ?? i18next.t("files:git.entryActions.systemPathActionFailed"),
      });
    }
  } else {
    setBanner({ variant: "error", message: result.message });
  }
}
