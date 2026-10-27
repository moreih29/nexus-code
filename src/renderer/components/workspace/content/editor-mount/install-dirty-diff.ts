/**
 * Wires the dirty-diff controller (gutter markers + inline peek) to a mounted
 * Monaco editor.
 *
 * Baseline source: the file's index version, fetched via `git.getFileContent`,
 * as VSCode's quick diff uses — the gutter shows the changes not yet staged,
 * and a change staged from the peek leaves it. The repo-relative path is
 * derived from the workspace's git session top-level. Untracked files resolve
 * to `null`, which the controller treats as "no diff" — matching VSCode, which
 * shows no quick-diff for untracked files.
 *
 * Refresh triggers:
 *   - buffer edits  → handled inside the controller (debounced recompute),
 *   - git.statusChanged that can move this file's index version (branch
 *     change, a change to this file's own status entry, or any change while
 *     it has staged changes) → reload baseline,
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
import type { DirtyChange } from "../../../../services/editor/git/dirty-diff/types";
import { lineChangeOfDirty } from "../../../../services/editor/git/staging/line-changes";
import { stageLines } from "../../../../services/editor/git/staging/stage-lines";
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
 * Resolves the index baseline for `filePath` in `workspaceId`, or null when the
 * file has no baseline (not a repo / outside repo / untracked / conflicted).
 */
async function loadIndexBaseline(
  workspaceId: string,
  filePath: string,
  signal: AbortSignal,
): Promise<string | null> {
  const relPath = repoRelPathFor(workspaceId, filePath);
  if (relPath === null) return null;

  const result = unwrapGitResult(
    await ipcCallResult(
      "git",
      "getFileContent",
      { workspaceId, ref: "INDEX", relPath },
      { signal },
    ),
  );
  return result.kind === "ok" ? result.content : null;
}

/** Stages one change of the buffer of `filePath`, whose text is `working`. */
async function stageBufferChange(
  workspaceId: string,
  filePath: string,
  change: DirtyChange,
  working: string,
  eol: string,
): Promise<void> {
  const relPath = repoRelPathFor(workspaceId, filePath);
  if (relPath === null) return;
  await stageLines({
    workspaceId,
    relPath,
    working,
    eol,
    ranges: [lineChangeOfDirty(change).modified],
  });
}

/** Repo-relative path of `filePath`, or null when there is no repo for it. */
function repoRelPathFor(workspaceId: string, filePath: string): string | null {
  const session = useGitStore.getState().sessions.get(workspaceId);
  if (!session || session.repoInfo.kind !== "repo") return null;
  return toRepoRelPath(session.repoInfo.topLevel, filePath);
}

/**
 * Summarises the parts of a status snapshot that can change the index version
 * of `relPath`: the branch, an in-progress operation, and the file's own
 * status entry (staging, a commit, `reset` or stash changes it). Files a
 * checkout or `reset --hard` rewrites arrive as a model reload instead.
 */
export function baselineSignature(status: GitStatus, relPath: string | null): string {
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

/** Whether `relPath` has changes in the index. */
export function hasStagedChanges(status: GitStatus, relPath: string | null): boolean {
  return relPath !== null && status.staged.some((entry) => entry.relPath === relPath);
}

export function installDirtyDiffForEditor({
  editor,
  monaco,
  input,
  getWorkspaceId,
}: InstallDirtyDiffInput): Monaco.IDisposable {
  const source: DirtyDiffSource = {
    loadBaseline: (signal) => loadIndexBaseline(getWorkspaceId(), input.filePath, signal),
    stageChange: (change, working, eol) =>
      stageBufferChange(getWorkspaceId(), input.filePath, change, working, eol),
  };

  const controller = new DirtyDiffController(editor, monaco, source);
  controller.start();

  // git.statusChanged is workspace-wide and arrives for every working-tree
  // change; reloading the baseline on each one ran `git show :<file>` for
  // every open editor, parked tabs included. Reload only when the snapshot
  // could have moved this file's index version. Staging more of a file that
  // already has staged changes leaves its entry as it was, so such a file
  // reloads on every snapshot.
  const relPathOf = () => repoRelPathFor(getWorkspaceId(), input.filePath);
  const signatureOf = (status: GitStatus | null | undefined): string | null =>
    status ? baselineSignature(status, relPathOf()) : null;
  let lastSignature = signatureOf(useGitStore.getState().sessions.get(getWorkspaceId())?.status);
  const unsubscribeGit = ipcListen("git", "statusChanged", (event) => {
    if (event.workspaceId !== getWorkspaceId()) return;
    const signature = signatureOf(event.status);
    if (signature === lastSignature && !hasStagedChanges(event.status, relPathOf())) return;
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
