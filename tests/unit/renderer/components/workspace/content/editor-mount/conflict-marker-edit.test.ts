import { describe, expect, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import { editMayAddMarker } from "../../../../../../../src/renderer/components/workspace/content/editor-mount/install-conflict-codelens";

function model(lines: string[]): Monaco.editor.ITextModel {
  return {
    getLineCount: () => lines.length,
    getLineContent: (line: number) => {
      if (line < 1 || line > lines.length) throw new Error(`line ${line} out of range`);
      return lines[line - 1];
    },
    getValue: () => {
      throw new Error("full-buffer read");
    },
  } as unknown as Monaco.editor.ITextModel;
}

function edit(
  startLineNumber: number,
  text: string,
  extra: Partial<Monaco.editor.IModelContentChangedEvent> = {},
) {
  return {
    changes: [{ range: { startLineNumber }, text }],
    isFlush: false,
    ...extra,
  } as unknown as Monaco.editor.IModelContentChangedEvent;
}

describe("editMayAddMarker", () => {
  test("ignores a keystroke on an ordinary line without reading the buffer", () => {
    expect(editMayAddMarker(model(["const a = 1;", "b"]), edit(1, "1"))).toBe(false);
  });

  test("detects a marker completed by typing", () => {
    expect(editMayAddMarker(model(["x", "<<<<<<< HEAD"]), edit(2, "<"))).toBe(true);
  });

  test("checks every line of a multi-line paste", () => {
    const lines = ["a", "<<<<<<< ours", "x", "=======", "y", ">>>>>>> theirs", "b"];
    expect(
      editMayAddMarker(model(lines), edit(1, "a\n<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs")),
    ).toBe(true);
  });

  test("falls back to a full scan for reloads and multi-cursor edits", () => {
    expect(editMayAddMarker(model(["a"]), edit(1, "", { isFlush: true }))).toBe(true);
    const multi = {
      changes: [
        { range: { startLineNumber: 1 }, text: "x" },
        { range: { startLineNumber: 2 }, text: "y" },
      ],
      isFlush: false,
    } as unknown as Monaco.editor.IModelContentChangedEvent;
    expect(editMayAddMarker(model(["a", "b"]), multi)).toBe(true);
  });
});
