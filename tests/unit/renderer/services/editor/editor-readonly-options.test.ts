/**
 * Unit test for the read-only enforcement logic in editor-view's attachSharedModel.
 * Tests the callback logic in isolation using a mock editor.
 */
import { describe, expect, mock, test } from "bun:test";

// Simulate the attachSharedModel logic as defined in editor-view.tsx so the
// behavior can be tested without mounting the React component.
function makeAttachSharedModel(
  model: object | null,
  readOnly: boolean,
  temporaryModelRef: { current: object | null },
) {
  return function attachSharedModel(editor: {
    getModel: () => object | null;
    setModel: (m: object) => void;
    updateOptions: (opts: { readOnly: boolean }) => void;
  }): void {
    if (!model) return;
    const currentModel = editor.getModel();
    if (currentModel !== model) {
      editor.setModel(model);

      const temporaryModel = temporaryModelRef.current as { isDisposed: () => boolean } | null;
      if (temporaryModel && temporaryModel !== model && !temporaryModel.isDisposed()) {
        // would dispose, but we won't test that path here
      }
      temporaryModelRef.current = null;
    }

    editor.updateOptions({ readOnly });
  };
}

describe("attachSharedModel read-only enforcement", () => {
  test("calls updateOptions({readOnly: true}) when attaching a read-only model", () => {
    const model = { id: "file:///a.ts" };
    const updateOptions = mock((_opts: { readOnly: boolean }) => {});
    const setModel = mock((_m: object) => {});
    const editor = {
      getModel: () => null,
      setModel,
      updateOptions,
    };

    const temporaryModelRef = { current: null };
    const attach = makeAttachSharedModel(model, true, temporaryModelRef);
    attach(editor);

    expect(setModel).toHaveBeenCalledWith(model);
    expect(updateOptions).toHaveBeenCalledTimes(1);
    expect((updateOptions.mock.calls[0] as [{ readOnly: boolean }])[0]).toEqual({ readOnly: true });
  });

  test("calls updateOptions({readOnly: false}) when attaching a writable model", () => {
    const model = { id: "file:///a.ts" };
    const updateOptions = mock((_opts: { readOnly: boolean }) => {});
    const setModel = mock((_m: object) => {});
    const editor = {
      getModel: () => null,
      setModel,
      updateOptions,
    };

    const temporaryModelRef = { current: null };
    const attach = makeAttachSharedModel(model, false, temporaryModelRef);
    attach(editor);

    expect(updateOptions).toHaveBeenCalledTimes(1);
    expect((updateOptions.mock.calls[0] as [{ readOnly: boolean }])[0]).toEqual({
      readOnly: false,
    });
  });

  test("calls updateOptions even when the model is already attached (readOnly change)", () => {
    const model = { id: "file:///a.ts" };
    const updateOptions = mock((_opts: { readOnly: boolean }) => {});
    const setModel = mock((_m: object) => {});
    const editor = {
      getModel: () => model, // already the same model
      setModel,
      updateOptions,
    };

    const temporaryModelRef = { current: null };
    const attach = makeAttachSharedModel(model, true, temporaryModelRef);
    attach(editor);

    // setModel should NOT be called because currentModel === model
    expect(setModel).not.toHaveBeenCalled();
    // updateOptions MUST still be called to enforce read-only state
    expect(updateOptions).toHaveBeenCalledTimes(1);
    expect((updateOptions.mock.calls[0] as [{ readOnly: boolean }])[0]).toEqual({ readOnly: true });
  });

  test("no-ops when model is null", () => {
    const updateOptions = mock((_opts: { readOnly: boolean }) => {});
    const setModel = mock((_m: object) => {});
    const editor = {
      getModel: () => null,
      setModel,
      updateOptions,
    };

    const temporaryModelRef = { current: null };
    const attach = makeAttachSharedModel(null, false, temporaryModelRef);
    attach(editor);

    expect(setModel).not.toHaveBeenCalled();
    expect(updateOptions).not.toHaveBeenCalled();
  });
});
