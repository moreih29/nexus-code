import type * as Monaco from "monaco-editor";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { installEditorIntegrations } from "./editor-mount/install-editor-integrations";
import { useRevealTargetRegistration } from "./editor-mount/use-reveal-target-registration";
import { useSharedModelAttach } from "./editor-mount/use-shared-model-attach";

export {
  type ApplySharedModelEditor,
  type AttachSharedModelTemporaryModel,
  applySharedModel,
} from "./editor-mount/apply-shared-model";

export interface UseEditorMountOptions {
  filePath: string;
  workspaceId: string;
  tabId: string;
  model: Monaco.editor.ITextModel | null;
  readOnly: boolean;
  phase: string;
}

export interface UseEditorMountResult {
  onMount: (editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) => void;
  attachSharedModel: (editor: Monaco.editor.IStandaloneCodeEditor) => void;
}

export function useEditorMount({
  filePath,
  workspaceId,
  tabId,
  model,
  readOnly,
  phase,
}: UseEditorMountOptions): UseEditorMountResult {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const openerDisposableRef = useRef<Monaco.IDisposable | null>(null);
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;

  const [mountedEditor, setMountedEditor] = useState<Monaco.editor.IStandaloneCodeEditor | null>(
    null,
  );

  const { attach: attachSharedModel, rememberAsTemporary } = useSharedModelAttach({
    editorRef,
    model,
    readOnly,
  });

  useRevealTargetRegistration({
    workspaceId,
    filePath,
    tabId,
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
      editor.onDidDispose(() => {
        if (editorRef.current === editor) editorRef.current = null;
      });
      rememberAsTemporary(editor);
      attachSharedModel(editor);
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
