/**
 * Unit test for the read-only enforcement logic in editor-view's attachSharedModel.
 * Tests applySharedModel (the extracted pure function from use-editor-mount.ts) directly
 * so that changes to the real implementation are caught at compile time.
 */
import { describe, expect, mock, test } from "bun:test";
import {
  type ApplySharedModelEditor,
  type AttachSharedModelTemporaryModel,
  applySharedModel,
} from "../../../../../src/renderer/components/workspace/content/use-editor-mount";

function makeEditor(currentModel: object | null = null): ApplySharedModelEditor & {
  setModel: ReturnType<typeof mock>;
  updateOptions: ReturnType<typeof mock>;
} {
  const setModel = mock((_m: object) => {});
  const updateOptions = mock((_opts: { readOnly: boolean }) => {});
  return {
    getModel: () => currentModel,
    setModel,
    updateOptions,
  };
}

function makeTemporaryModel(disposed = false): AttachSharedModelTemporaryModel & {
  dispose: ReturnType<typeof mock>;
} {
  const dispose = mock(() => {});
  return {
    isDisposed: () => disposed,
    dispose,
  };
}

describe("applySharedModel read-only enforcement", () => {
  test("calls updateOptions({readOnly: true}) when attaching a read-only model", () => {
    const model = { id: "file:///a.ts" };
    const editor = makeEditor(null);
    const temporaryModelRef = { current: null };

    applySharedModel(editor, model, true, temporaryModelRef);

    expect(editor.setModel).toHaveBeenCalledWith(model);
    expect(editor.updateOptions).toHaveBeenCalledTimes(1);
    expect((editor.updateOptions.mock.calls[0] as [{ readOnly: boolean }])[0]).toEqual({
      readOnly: true,
    });
  });

  test("calls updateOptions({readOnly: false}) when attaching a writable model", () => {
    const model = { id: "file:///a.ts" };
    const editor = makeEditor(null);
    const temporaryModelRef = { current: null };

    applySharedModel(editor, model, false, temporaryModelRef);

    expect(editor.updateOptions).toHaveBeenCalledTimes(1);
    expect((editor.updateOptions.mock.calls[0] as [{ readOnly: boolean }])[0]).toEqual({
      readOnly: false,
    });
  });

  test("calls updateOptions even when the model is already attached (readOnly change)", () => {
    const model = { id: "file:///a.ts" };
    const editor = makeEditor(model);
    const temporaryModelRef = { current: null };

    applySharedModel(editor, model, true, temporaryModelRef);

    // setModel should NOT be called because currentModel === model
    expect(editor.setModel).not.toHaveBeenCalled();
    // updateOptions MUST still be called to enforce read-only state
    expect(editor.updateOptions).toHaveBeenCalledTimes(1);
    expect((editor.updateOptions.mock.calls[0] as [{ readOnly: boolean }])[0]).toEqual({
      readOnly: true,
    });
  });

  test("no-ops when model is null", () => {
    const editor = makeEditor(null);
    const temporaryModelRef = { current: null };

    applySharedModel(editor, null, false, temporaryModelRef);

    expect(editor.setModel).not.toHaveBeenCalled();
    expect(editor.updateOptions).not.toHaveBeenCalled();
  });

  test("disposes temporary model when switching to a new shared model", () => {
    const newModel = { id: "file:///b.ts" };
    const tempModel = makeTemporaryModel(false);
    const editor = makeEditor(null);
    const temporaryModelRef: { current: AttachSharedModelTemporaryModel | null } = {
      current: tempModel,
    };

    applySharedModel(editor, newModel, false, temporaryModelRef);

    expect(editor.setModel).toHaveBeenCalledWith(newModel);
    expect(tempModel.dispose).toHaveBeenCalledTimes(1);
    expect(temporaryModelRef.current).toBeNull();
  });

  test("skips dispose when temporary model is already disposed", () => {
    const newModel = { id: "file:///b.ts" };
    const tempModel = makeTemporaryModel(true);
    const editor = makeEditor(null);
    const temporaryModelRef: { current: AttachSharedModelTemporaryModel | null } = {
      current: tempModel,
    };

    applySharedModel(editor, newModel, false, temporaryModelRef);

    expect(editor.setModel).toHaveBeenCalledWith(newModel);
    expect(tempModel.dispose).not.toHaveBeenCalled();
    expect(temporaryModelRef.current).toBeNull();
  });

  test("skips dispose when temporary model is the same as the new model", () => {
    const sharedModel = { id: "file:///a.ts" };
    const editor = makeEditor(null);
    const dispose = mock(() => {});
    const temporaryModelRef: { current: AttachSharedModelTemporaryModel | null } = {
      current: {
        isDisposed: () => false,
        dispose,
        // simulate same object identity
        ...(sharedModel as object),
      } as unknown as AttachSharedModelTemporaryModel,
    };
    // Override ref.current to be the exact same reference as sharedModel
    temporaryModelRef.current = sharedModel as unknown as AttachSharedModelTemporaryModel;

    applySharedModel(editor, sharedModel, false, temporaryModelRef);

    expect(editor.setModel).toHaveBeenCalledWith(sharedModel);
    // dispose must NOT be called because temporaryModel === model
    expect(dispose).not.toHaveBeenCalled();
  });
});
