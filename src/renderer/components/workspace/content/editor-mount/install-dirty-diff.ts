import type * as Monaco from "monaco-editor";
import type { GitStatus } from "../../../../../shared/git/types";
import { ipcCallResult, ipcListen, unwrapGitResult } from "../../../../ipc/client";
import type { EditorInput } from "../../../../services/editor";
import type { TextEncoding } from "../../../../services/editor/encoding/text-encoding";
import {
  DirtyDiffController,
  type DirtyDiffSource,
} from "../../../../services/editor/git/dirty-diff/controller";
import type { DirtyChange } from "../../../../services/editor/git/dirty-diff/types";
import { lineChangeOfDirty } from "../../../../services/editor/git/staging/line-changes";
import { stageLines } from "../../../../services/editor/git/staging/stage-lines";
import { getResolvedModel } from "../../../../services/editor/model/cache";
import { isDirty } from "../../../../services/editor/model/dirty-tracker";
import { decodeFileContent } from "../../../../services/editor/model/file-loader";
import { useGitStore } from "../../../../state/stores/git";

export interface InstallDirtyDiffInput {
  editor: Monaco.editor.IStandaloneCodeEditor;
  monaco: typeof Monaco;
  input: EditorInput;
  getWorkspaceId: () => string;
}

function toRepoRelPath(repoRoot: string, absPath: string): string | null {
  const root = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
  if (!absPath.startsWith(root)) return null;
  return absPath.slice(root.length);
}

async function loadIndexBaseline(
  workspaceId: string,
  filePath: string,
  encoding: TextEncoding | undefined,
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
  if (result.kind !== "ok") return null;
  const { kind: _kind, ...read } = result;
  return read.encoding === "bytes" ? decodeFileContent(read, encoding).content : read.content;
}

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

function repoRelPathFor(workspaceId: string, filePath: string): string | null {
  const session = useGitStore.getState().sessions.get(workspaceId);
  if (!session || session.repoInfo.kind !== "repo") return null;
  return toRepoRelPath(session.repoInfo.topLevel, filePath);
}

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

export function isUnchangedInStatus(status: GitStatus, relPath: string | null): boolean {
  if (relPath === null) return false;
  return (["merge", "staged", "working", "untracked"] as const).every(
    (key) =>
      !status[key].some((entry) => entry.relPath === relPath || entry.oldRelPath === relPath),
  );
}

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
    loadBaseline: (signal) =>
      loadIndexBaseline(
        getWorkspaceId(),
        input.filePath,
        getResolvedModel(input)?.encoding,
        signal,
      ),
    stageChange: (change, working, eol) =>
      stageBufferChange(getWorkspaceId(), input.filePath, change, working, eol),
  };

  const controller = new DirtyDiffController(editor, monaco, source);
  controller.start();

  const relPathOf = () => repoRelPathFor(getWorkspaceId(), input.filePath);
  const signatureOf = (status: GitStatus | null | undefined): string | null =>
    status ? baselineSignature(status, relPathOf()) : null;
  let lastSignature = signatureOf(useGitStore.getState().sessions.get(getWorkspaceId())?.status);
  const missedCommit = (status: GitStatus): boolean => {
    if (!controller.hasChanges || !isUnchangedInStatus(status, relPathOf())) return false;
    const cacheUri = getResolvedModel(input)?.cacheUri;
    return cacheUri !== undefined && !isDirty(cacheUri);
  };
  const unsubscribeGit = ipcListen("git", "statusChanged", (event) => {
    if (event.workspaceId !== getWorkspaceId()) return;
    const signature = signatureOf(event.status);
    if (
      signature === lastSignature &&
      !hasStagedChanges(event.status, relPathOf()) &&
      !missedCommit(event.status)
    ) {
      return;
    }
    lastSignature = signature;
    void controller.refreshBaseline();
  });

  const modelChange = editor.onDidChangeModel(() => {
    void controller.refreshBaseline();
  });

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
