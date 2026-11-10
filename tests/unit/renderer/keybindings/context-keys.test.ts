import { describe, expect, it } from "bun:test";
import { evaluateContextKey } from "../../../../src/renderer/keybindings/context-keys";

interface FakeAncestry {
  tagName?: string;
  isContentEditable?: boolean;
  matches?: string[];
}

function makeTarget(spec: FakeAncestry): HTMLElement {
  return {
    tagName: spec.tagName ?? "DIV",
    isContentEditable: spec.isContentEditable ?? false,
    closest(selector: string) {
      return spec.matches?.includes(selector) ? ({} as HTMLElement) : null;
    },
  } as unknown as HTMLElement;
}

function evt(target: HTMLElement | null): KeyboardEvent {
  return { target } as unknown as KeyboardEvent;
}

describe("evaluateContextKey", () => {
  describe("inputFocus", () => {
    it("is false inside Monaco (those are editorFocus, not inputFocus)", () => {
      // Monaco's host is a contentEditable but we want callers to scope
      // by `editorFocus` and reserve `inputFocus` for plain inputs.
      const e = evt(makeTarget({ isContentEditable: true, matches: [".monaco-editor"] }));
      expect(evaluateContextKey("inputFocus", e)).toBe(false);
    });
  });
});
