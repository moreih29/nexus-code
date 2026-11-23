export interface AttachSharedModelTemporaryModel {
  isDisposed(): boolean;
  dispose(): void;
}

export interface ApplySharedModelEditor {
  getModel(): unknown;
  setModel(m: unknown): void;
  updateOptions(opts: { readOnly: boolean }): void;
}

export function applySharedModel(
  editor: ApplySharedModelEditor,
  model: object | null,
  readOnly: boolean,
  temporaryModelRef: { current: AttachSharedModelTemporaryModel | null },
): void {
  if (!model) return;

  const maybeDisposable = editor as ApplySharedModelEditor & { isDisposed?: () => boolean };
  if (typeof maybeDisposable.isDisposed === "function" && maybeDisposable.isDisposed()) return;

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
