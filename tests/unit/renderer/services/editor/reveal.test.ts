/**
 * Reveal-flow unit tests.
 *
 * Covers two layers:
 *
 *   1. `revealRange` — the focus / setSelection / revealRangeInCenter call
 *      sequence on a single editor.
 *
 *   2. `registerRevealTarget` + `requestEditorReveal` — the registry that
 *      replaced the earlier broadcast-bus design. The bus broadcasted
 *      every reveal to every subscribed editor; with ContentHost keeping
 *      inactive editors mounted in a view park, the FIRST subscriber to
 *      claim a pending reveal was usually a parked (visibility:hidden)
 *      editor whose `editor.focus()` silently no-oped — leaving the
 *      visible editor unaware that anything had been requested. The
 *      registry keeps at most one editor per (workspaceId, filePath),
 *      with last-mount-wins semantics, and routes reveals to that single
 *      target.
 */

import { describe, expect, it, mock } from "bun:test";
import {
  registerRevealTarget,
  requestEditorReveal,
} from "../../../../../src/renderer/services/editor/tabs/pending-reveal";
import { revealRange } from "../../../../../src/renderer/services/editor/tabs";
import { __resetPendingEditorRevealsForTests } from "../../../../../src/renderer/services/editor/tabs/testing";

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
  startLineNumber: 194,
  startColumn: 5,
  endLineNumber: 194,
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

describe("requestEditorReveal — direct routing to registered editor", () => {
  it("calls revealRange immediately when a target is registered", () => {
    __resetPendingEditorRevealsForTests();
    const editor = makeStubEditor();
    const input = { workspaceId: "ws-1", filePath: "/abs/lead.toml" };

    registerRevealTarget(input, editor as never);

    requestEditorReveal({ ...input, range: RANGE_A });

    expect(editor.focus).toHaveBeenCalledTimes(1);
    expect(editor.setSelection).toHaveBeenLastCalledWith(RANGE_A);
    expect(editor.revealRangeInCenter).toHaveBeenLastCalledWith(RANGE_A);
  });

  it("delivers successive reveals on the same registered editor", () => {
    __resetPendingEditorRevealsForTests();
    const editor = makeStubEditor();
    const input = { workspaceId: "ws-1", filePath: "/abs/lead.toml" };

    registerRevealTarget(input, editor as never);

    requestEditorReveal({ ...input, range: RANGE_A });
    requestEditorReveal({ ...input, range: RANGE_B });

    // The bug this guards against: the second click on a different match
    // line in the same already-open file used to be silently swallowed.
    expect(editor.setSelection).toHaveBeenLastCalledWith(RANGE_B);
    expect(editor.revealRangeInCenter).toHaveBeenLastCalledWith(RANGE_B);
    expect(editor.focus).toHaveBeenCalledTimes(2);
    expect(editor.setSelection).toHaveBeenCalledTimes(2);
    expect(editor.revealRangeInCenter).toHaveBeenCalledTimes(2);
  });

  it("does not touch editors registered for a different workspace + path pair", () => {
    __resetPendingEditorRevealsForTests();
    const editor = makeStubEditor();

    registerRevealTarget({ workspaceId: "ws-1", filePath: "/abs/lead.toml" }, editor as never);

    requestEditorReveal({
      workspaceId: "ws-2",
      filePath: "/abs/other.toml",
      range: RANGE_A,
    });

    expect(editor.focus).not.toHaveBeenCalled();
    expect(editor.setSelection).not.toHaveBeenCalled();
    expect(editor.revealRangeInCenter).not.toHaveBeenCalled();
  });
});

describe("requestEditorReveal — pending queue when no target is registered", () => {
  it("queues a reveal and flushes it on the next registerRevealTarget for the same key", () => {
    __resetPendingEditorRevealsForTests();
    const editor = makeStubEditor();
    const input = { workspaceId: "ws-1", filePath: "/abs/lead.toml" };

    // No editor live yet — mirrors a search-match click that opens a new tab
    // before Monaco has finished mounting.
    requestEditorReveal({ ...input, range: RANGE_A });

    // Stub editor must NOT have been touched: nothing is registered yet.
    expect(editor.focus).not.toHaveBeenCalled();

    // Editor finishes mounting and registers itself; the queued reveal must
    // be flushed against this editor as part of registration.
    registerRevealTarget(input, editor as never);

    expect(editor.setSelection).toHaveBeenLastCalledWith(RANGE_A);
    expect(editor.revealRangeInCenter).toHaveBeenLastCalledWith(RANGE_A);
  });

  it("overwrites a stale queued reveal with the latest request before mount", () => {
    __resetPendingEditorRevealsForTests();
    const editor = makeStubEditor();
    const input = { workspaceId: "ws-1", filePath: "/abs/lead.toml" };

    requestEditorReveal({ ...input, range: RANGE_A });
    requestEditorReveal({ ...input, range: RANGE_B });

    registerRevealTarget(input, editor as never);

    // Only the latest range should land — the user clicked the second match
    // before the editor mounted, so RANGE_A is no longer relevant.
    expect(editor.setSelection).toHaveBeenCalledTimes(1);
    expect(editor.setSelection).toHaveBeenLastCalledWith(RANGE_B);
    expect(editor.revealRangeInCenter).toHaveBeenLastCalledWith(RANGE_B);
  });
});

describe("registerRevealTarget — last-mount-wins and identity-checked unregister", () => {
  it("routes reveals to the most recently registered editor for a key", () => {
    __resetPendingEditorRevealsForTests();
    const oldEditor = makeStubEditor();
    const newEditor = makeStubEditor();
    const input = { workspaceId: "ws-1", filePath: "/abs/lead.toml" };

    registerRevealTarget(input, oldEditor as never);
    // A second mount for the same file (e.g. preview-slot reuse remounts
    // EditorView, or HMR / leak left an old EditorView alive in the view
    // park) overwrites the registry entry. Subsequent reveals MUST go to
    // the new (visible) editor — not the old one.
    registerRevealTarget(input, newEditor as never);

    requestEditorReveal({ ...input, range: RANGE_A });

    expect(oldEditor.focus).not.toHaveBeenCalled();
    expect(oldEditor.setSelection).not.toHaveBeenCalled();
    expect(newEditor.focus).toHaveBeenCalledTimes(1);
    expect(newEditor.setSelection).toHaveBeenLastCalledWith(RANGE_A);
    expect(newEditor.revealRangeInCenter).toHaveBeenLastCalledWith(RANGE_A);
  });

  it("a late unmount of a displaced editor must not evict the current owner", () => {
    __resetPendingEditorRevealsForTests();
    const oldEditor = makeStubEditor();
    const newEditor = makeStubEditor();
    const input = { workspaceId: "ws-1", filePath: "/abs/lead.toml" };

    const unregisterOld = registerRevealTarget(input, oldEditor as never);
    registerRevealTarget(input, newEditor as never);

    // Old editor finally unmounts AFTER the new one already registered.
    // The cleanup must use an identity check so it doesn't accidentally
    // delete the new owner's entry.
    unregisterOld();

    requestEditorReveal({ ...input, range: RANGE_B });

    expect(newEditor.setSelection).toHaveBeenLastCalledWith(RANGE_B);
    expect(newEditor.revealRangeInCenter).toHaveBeenLastCalledWith(RANGE_B);
  });

  it("after the only registered editor unmounts, reveals queue for the next mount", () => {
    __resetPendingEditorRevealsForTests();
    const firstEditor = makeStubEditor();
    const secondEditor = makeStubEditor();
    const input = { workspaceId: "ws-1", filePath: "/abs/lead.toml" };

    const unregister = registerRevealTarget(input, firstEditor as never);
    unregister();

    // No editor live — request should queue.
    requestEditorReveal({ ...input, range: RANGE_A });
    expect(firstEditor.focus).not.toHaveBeenCalled();
    expect(secondEditor.focus).not.toHaveBeenCalled();

    // Re-mount drains the queue.
    registerRevealTarget(input, secondEditor as never);
    expect(secondEditor.setSelection).toHaveBeenLastCalledWith(RANGE_A);
    expect(secondEditor.revealRangeInCenter).toHaveBeenLastCalledWith(RANGE_A);
  });
});
