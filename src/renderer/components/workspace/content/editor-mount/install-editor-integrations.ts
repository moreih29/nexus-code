import type * as Monaco from "monaco-editor";
import type { EditorInput } from "../../../../services/editor";
import { installEditorOpener } from "../../../../services/editor/runtime/monaco-compensations";
import { installEditorSaveAction } from "../../../../services/editor/save/service";
import { createCrossFileOpenCodeEditorOpener } from "../../../../services/editor/tabs/cross-file-opener";

/**
 * Installs the Monaco-side integrations that turn a bare editor instance
 * into a full nexus-code editor surface:
 *
 *   - Cross-file `openCodeEditor` opener — replaces the default
 *     `editor.openCodeEditor` (which is a no-op when there's no
 *     editorService) so Cmd-click on an LSP definition opens the target
 *     file in our tab system.
 *   - Save action — wires Cmd+S to the save service for this editor's
 *     `EditorInput`.
 *
 * Returns a single disposer the caller drives on unmount or when the
 * editor instance is replaced. Save action is intentionally NOT disposed
 * — it's a Monaco command bound to this editor, garbage-collected with
 * the editor itself.
 */
export interface InstallEditorIntegrationsInput {
  editor: Monaco.editor.IStandaloneCodeEditor;
  monaco: typeof Monaco;
  input: EditorInput;
  /**
   * Late-bound resolver — `useEditorMount` keeps the latest workspaceId in
   * a ref so cross-file navigation always reads the current value, not the
   * one captured at install time.
   */
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
    openCodeEditor: (source: Monaco.editor.ICodeEditor, resource: Monaco.Uri) =>
      opener.openCodeEditor(source, resource),
  });

  installEditorSaveAction(editor, monaco, input);

  return openerDisposable;
}
