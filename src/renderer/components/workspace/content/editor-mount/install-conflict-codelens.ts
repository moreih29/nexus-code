/**
 * Wires the conflict-resolution CodeLens + decoration provider to a mounted
 * Monaco editor instance.
 *
 * Activation is lazy and model-scoped: the provider is installed once per
 * `EditorView` mount and re-evaluated on every model change. If the newly
 * active model does not contain conflict markers the previous installation is
 * disposed and no new one is created, so normal files are completely unaffected.
 *
 * Disposal chain:
 *   - `installConflictCodelensForEditor` returns a top-level disposer that the
 *     caller (typically `installEditorIntegrations` or the `useEditorMount`
 *     cleanup) must invoke on editor unmount.
 *   - Internally, each model-level installation (`ConflictCodelensInstallation`)
 *     is disposed before a new one is created on model change.
 */

import type * as Monaco from "monaco-editor";
import {
  installConflictCodelens,
  registerAcceptCommands,
  type ConflictCodelensInstallation,
} from "../../../../services/editor/conflict/conflict-codelens";
import { hasConflictMarkers } from "../../../../services/editor/conflict/conflict-parser";

/**
 * Installs the conflict CodeLens provider on `editor` and arranges for it to
 * be refreshed on model changes and content changes.
 *
 * @returns A disposer that tears down all listeners and the active provider.
 */
export function installConflictCodelensForEditor(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
): Monaco.IDisposable {
  let activeInstallation: ConflictCodelensInstallation | null = null;

  // Register the accept commands once for this editor. `editor.addCommand` has
  // no disposer, so registering per-model would leak commands; the generated
  // IDs are reused by every per-model installation below. When registration
  // fails the conflict UI is skipped entirely (degrades gracefully).
  const commandIds = registerAcceptCommands(editor);

  /** Creates or disposes the per-model installation based on whether the
   *  current model contains conflict markers. */
  function syncInstallation(): void {
    const model = editor.getModel();
    const text = model?.getValue() ?? "";

    if (commandIds !== null && hasConflictMarkers(text)) {
      if (activeInstallation === null) {
        // First conflict model (or model switched to a conflicted file): install.
        activeInstallation = installConflictCodelens({ editor, monaco, commandIds });
      } else {
        // Same editor, content changed (user typed / accepted a block): refresh.
        activeInstallation.refresh();
      }
    } else {
      // No conflict markers — tear down any existing installation.
      if (activeInstallation !== null) {
        activeInstallation.dispose();
        activeInstallation = null;
      }
    }
  }

  // React to the user switching to a different file in the same editor slot.
  const modelChangeDisposable = editor.onDidChangeModel(() => {
    // Dispose the old installation before checking the new model.
    if (activeInstallation !== null) {
      activeInstallation.dispose();
      activeInstallation = null;
    }
    syncInstallation();

    // Subscribe to content changes on the new model so accepted blocks refresh
    // decorations/CodeLens in real time without a full unmount/remount cycle.
    contentChangeDisposable?.dispose();
    contentChangeDisposable = editor.onDidChangeModelContent(onContentChange);
  });

  // React to the user editing the file (e.g. accepting a conflict block).
  function onContentChange(): void {
    syncInstallation();
  }
  let contentChangeDisposable: Monaco.IDisposable | null =
    editor.onDidChangeModelContent(onContentChange);

  // Run once immediately so the initial model gets the provider.
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
