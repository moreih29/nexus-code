import Editor from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { useEffect, useState } from "react";
import { fontFamily, typeScale } from "../../../../shared/design-tokens";
import { MAX_READABLE_FILE_SIZE } from "../../../../shared/fs/defaults";
import { ipcCallResult } from "../../../ipc/client";
import { useSharedModel } from "../../../services/editor";
import { hasConflictMarkers } from "../../../services/editor/conflict/conflict-parser";
import { useMonacoThemeName } from "../../../hooks/use-monaco-theme-name";
import { useGitSession, useGitStore } from "../../../state/stores/git";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { relPath } from "../../../utils/path";
import { fileErrorMessage } from "../../../utils/file-error";
import { EmptyState } from "../../ui/empty-state";
import { ConflictResolvedBanner } from "./conflict-resolved-banner";
import { ReadOnlyBanner } from "./read-only-banner";
import { useEditorMount } from "./use-editor-mount";

// Re-export for consumers (including drift-prone tests).
export { createCrossFileOpenCodeEditorOpener } from "../../../services/editor/tabs/cross-file-opener";

interface EditorViewProps {
  filePath: string;
  workspaceId: string;
}

const editorOptions = {
  minimap: { enabled: false },
  fontSize: typeScale.codeBody.fontSize,
  fontFamily: fontFamily.monoBody,
  scrollBeyondLastLine: false,
  automaticLayout: true,
} satisfies Monaco.editor.IStandaloneEditorConstructionOptions;

/**
 * Returns whether the current file is listed as conflicted in the git merge
 * group for this workspace. Uses `repoInfo.topLevel` to compute the
 * git-relative path that matches `GitStatusEntry.relPath`.
 */
function useIsFileConflicted(filePath: string, workspaceId: string): boolean {
  const session = useGitSession(workspaceId);
  if (!session?.status) return false;

  const repoRoot =
    session.repoInfo.kind === "repo"
      ? session.repoInfo.topLevel
      : useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId)?.rootPath ??
        null;

  if (!repoRoot) return false;

  const gitRelPath = relPath(filePath, repoRoot);
  return session.status.merge.some(
    (entry) => entry.relPath === gitRelPath && entry.conflictType !== null,
  );
}

/**
 * Tracks whether the Monaco model's current text contains conflict markers.
 * Subscribes to `onDidChangeContent` so the value updates in real time as the
 * user accepts conflict blocks.
 */
function useModelHasMarkers(model: Monaco.editor.ITextModel | null): boolean {
  const [hasMarkers, setHasMarkers] = useState<boolean>(() =>
    model ? hasConflictMarkers(model.getValue()) : false,
  );

  useEffect(() => {
    if (!model) {
      setHasMarkers(false);
      return;
    }
    setHasMarkers(hasConflictMarkers(model.getValue()));
    const disposable = model.onDidChangeContent(() => {
      setHasMarkers(hasConflictMarkers(model.getValue()));
    });
    return () => disposable.dispose();
  }, [model]);

  return hasMarkers;
}

export function EditorView({ filePath, workspaceId }: EditorViewProps) {
  const { model, phase, errorCode, readOnly } = useSharedModel({ workspaceId, filePath });
  const monacoTheme = useMonacoThemeName();

  const { onMount } = useEditorMount({
    filePath,
    workspaceId,
    model: model ?? null,
    readOnly,
    phase,
  });

  // Conflict-resolved banner state — only computed when the file is writable.
  const isConflicted = useIsFileConflicted(filePath, workspaceId);
  const hasMarkers = useModelHasMarkers(!readOnly ? (model ?? null) : null);
  const markResolved = useGitStore((s) => s.markResolved);

  if (phase === "loading" || (phase === "ready" && !model)) {
    return <EmptyState title="Loading…" tone="status" className="min-h-0" />;
  }

  if (phase === "binary") {
    return <EmptyState title="Cannot display binary file." tone="status" className="min-h-0" />;
  }

  if (phase === "error") {
    return (
      <EmptyState
        title={fileErrorMessage(errorCode ?? "OTHER", MAX_READABLE_FILE_SIZE / (1024 * 1024))}
        tone="status"
        className="min-h-0"
      />
    );
  }

  function handleMarkResolved(): void {
    const session = useGitStore.getState().sessions.get(workspaceId);
    if (!session) return;
    const repoRoot =
      session.repoInfo.kind === "repo"
        ? session.repoInfo.topLevel
        : useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId)?.rootPath ??
          null;
    if (!repoRoot) return;
    void markResolved(workspaceId, [relPath(filePath, repoRoot)]);
  }

  return (
    <div className="flex flex-col h-full">
      {readOnly && (
        <ReadOnlyBanner
          filePath={filePath}
          onRevealInFinder={() => {
            // Fire-and-forget: reveal in OS is a one-shot shell action with no UI feedback.
            void ipcCallResult("system", "revealInOS", { absPath: filePath });
          }}
        />
      )}
      {!readOnly && (
        <ConflictResolvedBanner
          isConflicted={isConflicted}
          hasMarkers={hasMarkers}
          onMarkResolved={handleMarkResolved}
        />
      )}
      <Editor
        height="100%"
        keepCurrentModel
        saveViewState={false}
        onMount={onMount}
        theme={monacoTheme}
        options={editorOptions}
      />
    </div>
  );
}
