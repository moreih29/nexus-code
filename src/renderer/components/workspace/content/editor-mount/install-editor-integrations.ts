import type * as Monaco from "monaco-editor";
import type { EditorInput } from "../../../../services/editor";
import { installEditorOpener } from "../../../../services/editor/runtime/monaco-compensations";
import { installEditorSaveAction } from "../../../../services/editor/save/service";
import { createCrossFileOpenCodeEditorOpener } from "../../../../services/editor/tabs/cross-file-opener";
import { installConflictCodelensForEditor } from "./install-conflict-codelens";
import { installDirtyDiffForEditor } from "./install-dirty-diff";

export interface InstallEditorIntegrationsInput {
  editor: Monaco.editor.IStandaloneCodeEditor;
  monaco: typeof Monaco;
  input: EditorInput;
  getWorkspaceId: () => string;
  getWorkspaceRoot: () => string | null;
}

export function installEditorIntegrations({
  editor,
  monaco,
  input,
  getWorkspaceId,
  getWorkspaceRoot,
}: InstallEditorIntegrationsInput): Monaco.IDisposable {
  const opener = createCrossFileOpenCodeEditorOpener({
    getWorkspaceId,
    getWorkspaceRoot,
    sourceEditor: editor,
  });
  const openerDisposable = installEditorOpener(monaco, {
    openCodeEditor: (source, resource, selectionOrPosition) =>
      opener.openCodeEditor(source, resource, selectionOrPosition),
  });

  const saveAction = installEditorSaveAction(editor, input);

  const conflictCodelensDisposable = installConflictCodelensForEditor(editor, monaco);

  const dirtyDiffDisposable = installDirtyDiffForEditor({
    editor,
    monaco,
    input,
    getWorkspaceId,
  });

  return {
    dispose() {
      openerDisposable.dispose();
      saveAction.dispose();
      conflictCodelensDisposable.dispose();
      dirtyDiffDisposable.dispose();
    },
  };
}
