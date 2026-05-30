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
 *   - git.statusChanged (commit/stage/checkout shifts HEAD) → reload baseline,
 *   - model swap in the same slot → reload baseline.
 *
 * Returns a disposer the caller drives on unmount, mirroring the conflict
 * codelens installer.
 */

import type * as Monaco from "monaco-editor";
import { ipcCallResult, unwrapGitResult } from "../../../../ipc/client";
import type { EditorInput } from "../../../../services/editor";
import {
  DirtyDiffController,
  type DirtyDiffSource,
} from "../../../../services/editor/git/dirty-diff/controller";
import { subscribeGitStatusChanged } from "../../../../services/editor/model/file-loader";
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
  const session = useGitStore.getState().sessions.get(workspaceId);
  if (!session || session.repoInfo.kind !== "repo") return null;

  const relPath = toRepoRelPath(session.repoInfo.topLevel, filePath);
  if (relPath === null) return null;

  const result = unwrapGitResult(
    await ipcCallResult("git", "getFileContent", { workspaceId, ref: "HEAD", relPath }, { signal }),
  );
  return result.kind === "ok" ? result.content : null;
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

  const unsubscribeGit = subscribeGitStatusChanged(input, () => {
    void controller.refreshBaseline();
  });

  const modelChange = editor.onDidChangeModel(() => {
    void controller.refreshBaseline();
  });

  return {
    dispose() {
      unsubscribeGit();
      modelChange.dispose();
      controller.dispose();
    },
  };
}
