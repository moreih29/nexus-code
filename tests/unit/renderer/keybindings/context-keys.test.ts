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
  describe("editorFocus", () => {
    it("is true when target is inside Monaco", () => {
      const e = evt(makeTarget({ matches: [".monaco-editor"] }));
      expect(evaluateContextKey("editorFocus", e)).toBe(true);
    });

    it("is true when target is inside CodeMirror", () => {
      const e = evt(makeTarget({ matches: [".cm-editor"] }));
      expect(evaluateContextKey("editorFocus", e)).toBe(true);
    });

    it("is false for a plain DIV", () => {
      const e = evt(makeTarget({}));
      expect(evaluateContextKey("editorFocus", e)).toBe(false);
    });
  });

  describe("inputFocus", () => {
    it("is true for INPUT", () => {
      expect(evaluateContextKey("inputFocus", evt(makeTarget({ tagName: "INPUT" })))).toBe(true);
    });

    it("is true for TEXTAREA", () => {
      expect(evaluateContextKey("inputFocus", evt(makeTarget({ tagName: "TEXTAREA" })))).toBe(true);
    });

    it("is true for contentEditable DIV", () => {
      expect(evaluateContextKey("inputFocus", evt(makeTarget({ isContentEditable: true })))).toBe(
        true,
      );
    });

    it("is false inside Monaco (those are editorFocus, not inputFocus)", () => {
      // Monaco's host is a contentEditable but we want callers to scope
      // by `editorFocus` and reserve `inputFocus` for plain inputs.
      const e = evt(makeTarget({ isContentEditable: true, matches: [".monaco-editor"] }));
      expect(evaluateContextKey("inputFocus", e)).toBe(false);
    });
  });

  describe("fileTreeFocus", () => {
    it("is true when target is inside [role='tree']", () => {
      const e = evt(makeTarget({ matches: ['[role="tree"]'] }));
      expect(evaluateContextKey("fileTreeFocus", e)).toBe(true);
    });

    it("is false when target is outside the tree", () => {
      const e = evt(makeTarget({}));
      expect(evaluateContextKey("fileTreeFocus", e)).toBe(false);
    });
  });

  describe("terminalFocus", () => {
    it("is true when target is inside .xterm", () => {
      const e = evt(makeTarget({ matches: [".xterm"] }));
      expect(evaluateContextKey("terminalFocus", e)).toBe(true);
    });
  });

  describe("commandPaletteFocus", () => {
    it("is true when target is inside the command palette root", () => {
      const e = evt(makeTarget({ matches: ["[data-command-palette-root]"] }));
      expect(evaluateContextKey("commandPaletteFocus", e)).toBe(true);
    });
  });

  describe("unknown / null", () => {
    it("returns false for an unknown key", () => {
      expect(evaluateContextKey("nonsense", evt(makeTarget({})))).toBe(false);
    });

    it("returns false when target is null", () => {
      expect(evaluateContextKey("editorFocus", evt(null))).toBe(false);
      expect(evaluateContextKey("inputFocus", evt(null))).toBe(false);
      expect(evaluateContextKey("fileTreeFocus", evt(null))).toBe(false);
    });
  });
});
