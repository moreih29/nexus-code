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

  // Defensive guard: callers track liveness via `onDidDispose` (see
  // useEditorMount), but the React effect that fires `attach` could still
  // race with a synchronous dispose path that nobody observed in time. A
  // setModel against the disposed editor surfaces as "InstantiationService
  // has been disposed" and tears down the workspace pane. Monaco's
  // IStandaloneCodeEditor type does not expose `isDisposed`, so we feature-
  // detect at the call site (it exists on the concrete `Editor` class) and
  // bail before touching the dead instance.
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
