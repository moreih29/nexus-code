import { afterAll, describe, expect, it, mock } from "bun:test";
import {
  registerRevealTarget,
  requestEditorReveal,
} from "../../../../../src/renderer/services/editor/tabs/pending-reveal";
import { __resetPendingEditorRevealsForTests } from "../../../../../src/renderer/services/editor/tabs/testing";

const frames: FrameRequestCallback[] = [];
const originalRaf = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
  frames.push(callback)) as typeof requestAnimationFrame;
afterAll(() => {
  globalThis.requestAnimationFrame = originalRaf;
});

interface StubEditor {
  focus: ReturnType<typeof mock>;
  setSelection: ReturnType<typeof mock>;
  revealRangeInCenter: ReturnType<typeof mock>;
  getLayoutInfo: () => { height: number };
  onDidLayoutChange: (listener: (layout: { height: number }) => void) => { dispose(): void };
  layOut(height: number): void;
}

function makeStubEditor(height = 600): StubEditor {
  let current = height;
  const listeners = new Set<(layout: { height: number }) => void>();
  return {
    focus: mock(() => {}),
    setSelection: mock((_range: unknown) => {}),
    revealRangeInCenter: mock((_range: unknown) => {}),
    getLayoutInfo: () => ({ height: current }),
    onDidLayoutChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    layOut(next) {
      current = next;
      for (const listener of [...listeners]) listener({ height: next });
    },
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

describe("requestEditorReveal — pending queue when no target is registered", () => {
  it("queues a reveal and flushes it on the next registerRevealTarget for the same key", () => {
    __resetPendingEditorRevealsForTests();
    const editor = makeStubEditor();
    const input = { workspaceId: "ws-1", filePath: "/abs/lead.toml" };

    requestEditorReveal({ ...input, range: RANGE_A });

    expect(editor.focus).not.toHaveBeenCalled();

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

    requestEditorReveal({ ...input, range: RANGE_A });
    expect(firstEditor.focus).not.toHaveBeenCalled();
    expect(secondEditor.focus).not.toHaveBeenCalled();

    registerRevealTarget(input, secondEditor as never);
    expect(secondEditor.setSelection).toHaveBeenLastCalledWith(RANGE_A);
    expect(secondEditor.revealRangeInCenter).toHaveBeenLastCalledWith(RANGE_A);
  });
});
