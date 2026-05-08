import type * as Monaco from "monaco-editor";
import { useCallback, useEffect, useRef } from "react";
import { installEditorOpener } from "../../../services/editor/runtime/monaco-compensations";
import { installEditorSaveAction } from "../../../services/editor/save/save-service";
import { createCrossFileOpenCodeEditorOpener } from "../../../services/editor/tabs/cross-file-opener";
import {
  applyPendingReveal,
  subscribePendingEditorReveal,
} from "../../../services/editor/tabs";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import type { EditorInput } from "../../../services/editor";

export interface AttachSharedModelTemporaryModel {
  isDisposed(): boolean;
  dispose(): void;
}

// Minimal editor surface required by applySharedModel — kept structurally
// compatible with Monaco.editor.IStandaloneCodeEditor so tests can pass stubs.
export interface ApplySharedModelEditor {
  getModel(): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setModel(m: any): void;
  updateOptions(opts: { readOnly: boolean }): void;
}

export function applySharedModel(
  editor: ApplySharedModelEditor,
  model: object | null,
  readOnly: boolean,
  temporaryModelRef: { current: AttachSharedModelTemporaryModel | null },
): void {
  if (!model) return;
  const currentModel = editor.getModel();
  if (currentModel !== model) {
    editor.setModel(model);

    const temporaryModel = temporaryModelRef.current;
    if (temporaryModel && temporaryModel !== model && !temporaryModel.isDisposed()) {
      temporaryModel.dispose();
    }
    temporaryModelRef.current = null;
  }

  editor.updateOptions({ readOnly });
}

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
  const temporaryModelRef = useRef<Monaco.editor.ITextModel | null>(null);
  workspaceIdRef.current = workspaceId;

  const attachSharedModel = useCallback(
    (editor: Monaco.editor.IStandaloneCodeEditor): void => {
      applySharedModel(editor, model, readOnly, temporaryModelRef);
    },
    [model, readOnly],
  );

  useEffect(() => {
    const editor = editorRef.current;
    if (editor) attachSharedModel(editor);
  }, [attachSharedModel]);

  useEffect(() => {
    if (phase !== "ready") return;
    const editor = editorRef.current;
    if (!editor) return;

    applyPendingReveal(editor, workspaceId, filePath);
    return subscribePendingEditorReveal((pending) => {
      if (pending.workspaceId !== workspaceId || pending.filePath !== filePath) return;
      const currentEditor = editorRef.current;
      if (!currentEditor) return;
      applyPendingReveal(currentEditor, workspaceId, filePath);
    });
  }, [phase, workspaceId, filePath]);

  useEffect(
    () => () => {
      openerDisposableRef.current?.dispose();
      openerDisposableRef.current = null;
      editorRef.current = null;
      temporaryModelRef.current = null;
    },
    [],
  );

  const onMount = useCallback(
    (editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco): void => {
      editorRef.current = editor;
      temporaryModelRef.current = editor.getModel();
      attachSharedModel(editor);
      applyPendingReveal(editor, workspaceId, filePath);

      openerDisposableRef.current?.dispose();
      const openCodeEditorOpener = createCrossFileOpenCodeEditorOpener({
        getWorkspaceId: () => workspaceIdRef.current,
        getWorkspaceRoot: () => {
          const ws = useWorkspacesStore
            .getState()
            .workspaces.find((w) => w.id === workspaceIdRef.current);
          return ws?.rootPath ?? null;
        },
        sourceEditor: editor,
      });
      openerDisposableRef.current = installEditorOpener(monaco, {
        openCodeEditor: (source: Monaco.editor.ICodeEditor, resource: Monaco.Uri) =>
          openCodeEditorOpener.openCodeEditor(source, resource),
      });

      const input: EditorInput = { workspaceId, filePath };
      installEditorSaveAction(editor, monaco, input);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // workspaceId and filePath are stable per mount — EditorView remounts on filePath change
    [attachSharedModel, filePath, workspaceId],
  );

  return { onMount, attachSharedModel };
}
