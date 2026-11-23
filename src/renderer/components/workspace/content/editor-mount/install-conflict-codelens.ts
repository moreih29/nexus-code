import type * as Monaco from "monaco-editor";
import {
  type ConflictCodelensInstallation,
  installConflictCodelens,
  registerAcceptCommands,
} from "../../../../services/editor/conflict/conflict-codelens";
import { hasConflictMarkers } from "../../../../services/editor/conflict/conflict-parser";

export function installConflictCodelensForEditor(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
): Monaco.IDisposable {
  let activeInstallation: ConflictCodelensInstallation | null = null;

  const commandIds = registerAcceptCommands(editor);

  function syncInstallation(): void {
    const model = editor.getModel();
    const text = model?.getValue() ?? "";

    if (commandIds !== null && hasConflictMarkers(text)) {
      if (activeInstallation === null) {
        activeInstallation = installConflictCodelens({ editor, monaco, commandIds });
      } else {
        activeInstallation.refresh();
      }
    } else {
      if (activeInstallation !== null) {
        activeInstallation.dispose();
        activeInstallation = null;
      }
    }
  }

  const modelChangeDisposable = editor.onDidChangeModel(() => {
    if (activeInstallation !== null) {
      activeInstallation.dispose();
      activeInstallation = null;
    }
    syncInstallation();

    contentChangeDisposable?.dispose();
    contentChangeDisposable = editor.onDidChangeModelContent(onContentChange);
  });

  function onContentChange(event: Monaco.editor.IModelContentChangedEvent): void {
    if (activeInstallation === null && !editMayAddMarker(editor.getModel(), event)) return;
    syncInstallation();
  }
  let contentChangeDisposable: Monaco.IDisposable | null =
    editor.onDidChangeModelContent(onContentChange);

  syncInstallation();

  return {
    dispose() {
      modelChangeDisposable.dispose();
      contentChangeDisposable?.dispose();
      contentChangeDisposable = null;
      if (activeInstallation !== null) {
        activeInstallation.dispose();
        activeInstallation = null;
      }
    },
  };
}

export function editMayAddMarker(
  model: Monaco.editor.ITextModel | null,
  event: Monaco.editor.IModelContentChangedEvent,
): boolean {
  if (!model) return false;
  if (event.isFlush || event.changes.length !== 1) return true;
  const [change] = event.changes;
  const insertedLines = change.text.split("\n").length;
  const first = change.range.startLineNumber;
  const last = Math.min(model.getLineCount(), first + insertedLines - 1);
  for (let line = first; line <= last; line++) {
    if (hasConflictMarkers(model.getLineContent(line))) return true;
  }
  return false;
}
