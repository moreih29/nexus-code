/**
 * Reveal-flow unit tests.
 *
 * The visible regression we're guarding against: clicking a search match
 * (or a workspace-symbol palette entry) on a file that's already open
 * should jump the editor's selection AND viewport to the match line. The
 * earlier implementation called only `setSelection` + `revealRangeInCenter`
 * without `focus`, and on an unfocused editor Monaco was treating the
 * viewport call as low-priority — successive reveals on the same file
 * stuck at whatever line the first reveal had landed on.
 */

import { describe, expect, it, mock } from "bun:test";
import {
  __resetPendingEditorRevealsForTests,
  applyPendingReveal,
  requestEditorReveal,
  revealRange,
} from "../../../../../src/renderer/services/editor/tabs";

interface StubEditor {
  focus: ReturnType<typeof mock>;
  setSelection: ReturnType<typeof mock>;
  revealRangeInCenter: ReturnType<typeof mock>;
}

function makeStubEditor(): StubEditor {
  return {
    focus: mock(() => {}),
    setSelection: mock((_range: unknown) => {}),
    revealRangeInCenter: mock((_range: unknown) => {}),
  };
}

const RANGE_A = {
  startLineNumber: 24,
  startColumn: 1,
  endLineNumber: 24,
  endColumn: 7,
};

const RANGE_B = {
  startLineNumber: 34,
  startColumn: 5,
  endLineNumber: 34,
  endColumn: 11,
};

describe("revealRange", () => {
  it("focuses the editor before moving selection and viewport", () => {
    const editor = makeStubEditor();

    revealRange(editor as never, RANGE_A);

    expect(editor.focus).toHaveBeenCalledTimes(1);
    expect(editor.setSelection).toHaveBeenCalledTimes(1);
    expect(editor.setSelection).toHaveBeenCalledWith(RANGE_A);
    expect(editor.revealRangeInCenter).toHaveBeenCalledTimes(1);
    expect(editor.revealRangeInCenter).toHaveBeenCalledWith(RANGE_A);

    // Order: focus must happen before selection/viewport calls so Monaco
    // treats the editor as the active surface for the upcoming layout pass.
    const focusOrder = editor.focus.mock.invocationCallOrder[0]!;
    const selectionOrder = editor.setSelection.mock.invocationCallOrder[0]!;
    const revealOrder = editor.revealRangeInCenter.mock.invocationCallOrder[0]!;
    expect(focusOrder).toBeLessThan(selectionOrder);
    expect(selectionOrder).toBeLessThan(revealOrder);
  });
});

describe("applyPendingReveal — successive calls", () => {
  it("applies a fresh range every time a new pending entry is taken", () => {
    __resetPendingEditorRevealsForTests();
    const editor = makeStubEditor();
    const input = { workspaceId: "ws-1", filePath: "/abs/lead.toml" };

    requestEditorReveal({ ...input, range: RANGE_A });
    applyPendingReveal(editor as never, input.workspaceId, input.filePath);

    expect(editor.setSelection).toHaveBeenLastCalledWith(RANGE_A);
    expect(editor.revealRangeInCenter).toHaveBeenLastCalledWith(RANGE_A);

    requestEditorReveal({ ...input, range: RANGE_B });
    applyPendingReveal(editor as never, input.workspaceId, input.filePath);

    // Second click on the same file with a different range must reach the
    // editor — the bug was that this second pair never updated the viewport.
    expect(editor.setSelection).toHaveBeenLastCalledWith(RANGE_B);
    expect(editor.revealRangeInCenter).toHaveBeenLastCalledWith(RANGE_B);
    expect(editor.focus).toHaveBeenCalledTimes(2);
    expect(editor.setSelection).toHaveBeenCalledTimes(2);
    expect(editor.revealRangeInCenter).toHaveBeenCalledTimes(2);
  });

  it("is a no-op when nothing is queued for the editor's input", () => {
    __resetPendingEditorRevealsForTests();
    const editor = makeStubEditor();

    applyPendingReveal(editor as never, "ws-1", "/abs/none.toml");

    expect(editor.focus).not.toHaveBeenCalled();
    expect(editor.setSelection).not.toHaveBeenCalled();
    expect(editor.revealRangeInCenter).not.toHaveBeenCalled();
  });

  it("ignores reveals queued for a different workspace + path pair", () => {
    __resetPendingEditorRevealsForTests();
    const editor = makeStubEditor();

    requestEditorReveal({
      workspaceId: "ws-2",
      filePath: "/abs/other.toml",
      range: RANGE_A,
    });

    applyPendingReveal(editor as never, "ws-1", "/abs/lead.toml");

    expect(editor.focus).not.toHaveBeenCalled();
    expect(editor.setSelection).not.toHaveBeenCalled();
    expect(editor.revealRangeInCenter).not.toHaveBeenCalled();
  });
});
