/**
 * Wires the dirty-diff controller (gutter markers + inline peek) to a mounted
 * Monaco editor.
 *
 * Baseline source: the file's HEAD blob, fetched via `git.getFileContent`. The
 * repo-relative path is derived from the workspace's git session top-level.
 * Untracked / new-at-HEAD files resolve to `null`, which the controller treats
 * as "no diff" — matching VSCode, which shows no quick-diff for untracked files.
 *
 * Refresh triggers:
 *   - buffer edits  → handled inside the controller (debounced recompute),
 *   - git.statusChanged that can move this file's HEAD blob (branch change or
 *     a change to this file's own status entry) → reload baseline,
 *   - a reload of the model from disk (checkout / reset rewrote the file),
 *   - model swap in the same slot → reload baseline.
 *
 * Returns a disposer the caller drives on unmount, mirroring the conflict
 * codelens installer.
 */

import type * as Monaco from "monaco-editor";
import type { GitStatus } from "../../../../../shared/git/types";
import { ipcCallResult, ipcListen, unwrapGitResult } from "../../../../ipc/client";
import type { EditorInput } from "../../../../services/editor";
import {
  DirtyDiffController,
  type DirtyDiffSource,
} from "../../../../services/editor/git/dirty-diff/controller";
import { useGitStore } from "../../../../state/stores/git";

export interface InstallDirtyDiffInput {
  editor: Monaco.editor.IStandaloneCodeEditor;
  monaco: typeof Monaco;
  input: EditorInput;
  getWorkspaceId: () => string;
}

/** Strips the repo-root prefix to produce a git-relative path, or null. */
function toRepoRelPath(repoRoot: string, absPath: string): string | null {
  const root = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
  if (!absPath.startsWith(root)) return null;
  return absPath.slice(root.length);
}

/**
 * Resolves the HEAD baseline for `filePath` in `workspaceId`, or null when the
 * file has no baseline (not a repo / outside repo / untracked / new at HEAD).
 */
async function loadHeadBaseline(
  workspaceId: string,
  filePath: string,
  signal: AbortSignal,
): Promise<string | null> {
  const relPath = repoRelPathFor(workspaceId, filePath);
  if (relPath === null) return null;

  const result = unwrapGitResult(
    await ipcCallResult("git", "getFileContent", { workspaceId, ref: "HEAD", relPath }, { signal }),
  );
  return result.kind === "ok" ? result.content : null;
}

/** Repo-relative path of `filePath`, or null when there is no repo for it. */
function repoRelPathFor(workspaceId: string, filePath: string): string | null {
  const session = useGitStore.getState().sessions.get(workspaceId);
  if (!session || session.repoInfo.kind !== "repo") return null;
  return toRepoRelPath(session.repoInfo.topLevel, filePath);
}

/**
 * Summarises the parts of a status snapshot that can change the HEAD blob of
 * `relPath`: the branch, an in-progress operation, and the file's own status
 * entry (a commit, `reset --soft` or stash changes it). Files a checkout or
 * `reset --hard` rewrites arrive as a model reload instead.
 */
export function headBaselineSignature(status: GitStatus, relPath: string | null): string {
  const branch = status.branch;
  const parts = [
    branch ? `${branch.current}\0${branch.isUnborn}\0${branch.ahead}\0${branch.behind}` : "-",
    status.operationState.kind,
  ];
  if (relPath !== null) {
    for (const key of ["merge", "staged", "working", "untracked"] as const) {
      for (const entry of status[key]) {
        if (entry.relPath === relPath || entry.oldRelPath === relPath) {
          parts.push(`${key}:${entry.xy}`);
        }
      }
    }
  }
  return parts.join("|");
}

export function installDirtyDiffForEditor({
  editor,
  monaco,
  input,
  getWorkspaceId,
}: InstallDirtyDiffInput): Monaco.IDisposable {
  const source: DirtyDiffSource = {
    loadBaseline: (signal) => loadHeadBaseline(getWorkspaceId(), input.filePath, signal),
  };

  const controller = new DirtyDiffController(editor, monaco, source);
  controller.start();

  // git.statusChanged is workspace-wide and arrives for every working-tree
  // change; reloading the baseline on each one ran `git show HEAD:<file>` for
  // every open editor, parked tabs included. Reload only when the snapshot
  // could have moved this file's HEAD blob.
  const signatureOf = (status: GitStatus | null | undefined): string | null =>
    status ? headBaselineSignature(status, repoRelPathFor(getWorkspaceId(), input.filePath)) : null;
  let lastSignature = signatureOf(useGitStore.getState().sessions.get(getWorkspaceId())?.status);
  const unsubscribeGit = ipcListen("git", "statusChanged", (event) => {
    if (event.workspaceId !== getWorkspaceId()) return;
    const signature = signatureOf(event.status);
    if (signature === lastSignature) return;
    lastSignature = signature;
    void controller.refreshBaseline();
  });

  const modelChange = editor.onDidChangeModel(() => {
    void controller.refreshBaseline();
  });

  // setValue (a reload from disk) flushes the model; the file may have been
  // rewritten by a checkout or reset that moved HEAD on the same branch.
  const contentFlush = editor.onDidChangeModelContent((event) => {
    if (event.isFlush) void controller.refreshBaseline();
  });

  return {
    dispose() {
      unsubscribeGit();
      modelChange.dispose();
      contentFlush.dispose();
      controller.dispose();
    },
  };
}
