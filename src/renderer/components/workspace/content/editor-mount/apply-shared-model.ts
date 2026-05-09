/**
 * Pure function: attaches a shared `ITextModel` to a Monaco editor and
 * disposes the temporary model created by Monaco at construction time.
 *
 * Kept structurally typed (not depending on Monaco type identity) so unit
 * tests can pass plain stubs without spinning up the real editor.
 */

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
