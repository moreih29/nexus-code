import type * as Monaco from "monaco-editor";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { installEditorIntegrations } from "./editor-mount/install-editor-integrations";
import { useRevealTargetRegistration } from "./editor-mount/use-reveal-target-registration";
import { useSharedModelAttach } from "./editor-mount/use-shared-model-attach";

// Re-export for backwards-compatible test imports. Existing call sites
// (`tests/unit/renderer/services/editor/editor-readonly-options.test.ts`)
// pull `applySharedModel` from this module — keeping the re-export here
// avoids churning unrelated tests during the split.
export {
  applySharedModel,
  type ApplySharedModelEditor,
  type AttachSharedModelTemporaryModel,
} from "./editor-mount/apply-shared-model";

export interface UseEditorMountOptions {
  filePath: string;
  workspaceId: string;
  model: Monaco.editor.ITextModel | null;
  readOnly: boolean;
  phase: string;
}

export interface UseEditorMountResult {
  onMount: (editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) => void;
  attachSharedModel: (editor: Monaco.editor.IStandaloneCodeEditor) => void;
}

/**
 * Orchestrates the lifecycle of a Monaco editor instance for a single
 * `(workspaceId, filePath)` mount. Composition only — each side-effect
 * lives in its own focused module under `./editor-mount/`:
 *
 *   - `useSharedModelAttach`           — model attach + temp-model disposal
 *   - `useRevealTargetRegistration`    — reveal-target registry registration
 *   - `installEditorIntegrations`      — cross-file opener + save action
 *
 * What this hook owns:
 *   - `editorRef`              the live editor instance for sync side-effect callers
 *   - `mountedEditor` state    triggers the registry effect once Monaco fires onMount
 *   - `openerDisposableRef`    holds the integration disposer for cleanup
 *   - `workspaceIdRef`         late-bound resolver for cross-file navigation
 */
export function useEditorMount({
  filePath,
  workspaceId,
  model,
  readOnly,
  phase,
}: UseEditorMountOptions): UseEditorMountResult {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const openerDisposableRef = useRef<Monaco.IDisposable | null>(null);
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;

  // Triggers re-render after Monaco's async onMount fires. The reveal-target
  // registration effect depends on this so it fires once the editor instance
  // is actually live (otherwise its first commit happens before onMount and
  // there's no editor to register).
  const [mountedEditor, setMountedEditor] = useState<
    Monaco.editor.IStandaloneCodeEditor | null
  >(null);

  const { attach: attachSharedModel, rememberAsTemporary } = useSharedModelAttach({
    editorRef,
    model,
    readOnly,
  });

  useRevealTargetRegistration({
    workspaceId,
    filePath,
    editor: mountedEditor,
    ready: phase === "ready",
  });

  useEffect(
    () => () => {
      openerDisposableRef.current?.dispose();
      openerDisposableRef.current = null;
      editorRef.current = null;
    },
    [],
  );

  const onMount = useCallback(
    (editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco): void => {
      editorRef.current = editor;
      rememberAsTemporary(editor);
      attachSharedModel(editor);
      // Publish the live editor so the registry effect can fire. setState
      // here is intentionally after attachSharedModel so the real model is
      // in place before any queued reveal flushes against it — flushing
      // against the temporary empty model would land on the wrong text.
      setMountedEditor(editor);

      openerDisposableRef.current?.dispose();
      openerDisposableRef.current = installEditorIntegrations({
        editor,
        monaco,
        input: { workspaceId, filePath },
        getWorkspaceId: () => workspaceIdRef.current,
        getWorkspaceRoot: () => {
          const ws = useWorkspacesStore
            .getState()
            .workspaces.find((w) => w.id === workspaceIdRef.current);
          return ws?.rootPath ?? null;
        },
      });
    },
    [attachSharedModel, rememberAsTemporary, filePath, workspaceId],
  );

  return { onMount, attachSharedModel };
}
