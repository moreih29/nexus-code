import { beforeEach, describe, expect, mock, test } from "bun:test";
import type * as Monaco from "monaco-editor";

// ---------------------------------------------------------------------------
// Fake Monaco — captures addKeybindingRules calls and supplies the KeyMod /
// KeyCode constants the converter reads. Exact numeric values are arbitrary;
// the tests assert relationships (same command unbound/bound, idempotency),
// not absolute encodings.
//
// The monaco-singleton is stubbed via mock.module (bun mocks are global and
// another test file replaces requireMonaco with a thrower) — so we register
// OUR stub and dynamic-import the subject AFTER it, binding apply.ts to this
// fake regardless of cross-file evaluation order.
// ---------------------------------------------------------------------------

interface Rule {
  keybinding: number;
  command: string;
}

const calls: Rule[][] = [];

const KeyMod = { CtrlCmd: 1 << 11, Shift: 1 << 10, Alt: 1 << 9, WinCtrl: 1 << 8 };

// Stable per-name code numbers for every member the converter may look up.
const KeyCode = new Proxy(
  {},
  {
    get(_t, prop: string) {
      let h = 0;
      for (let i = 0; i < prop.length; i++) h = (h * 31 + prop.charCodeAt(i)) & 0xff;
      return h | 0x1000; // keep it a distinct, non-zero number
    },
  },
) as unknown as typeof Monaco.KeyCode;

const fakeMonaco = {
  KeyMod,
  KeyCode,
  editor: {
    addKeybindingRules: (rules: Rule[]) => {
      calls.push(rules);
    },
  },
} as unknown as typeof Monaco;

mock.module("../../../../../../src/renderer/services/editor/runtime/monaco-singleton", () => ({
  initializeMonacoSingleton: () => {},
  isMonacoReady: () => true,
  onMonacoReady: () => () => {},
  requireMonaco: () => fakeMonaco,
}));

const { applyEditorKeybindingOverrides, __resetAppliedEditorBindingsForTests } = await import(
  "../../../../../../src/renderer/services/editor/keybindings/apply"
);

const COMMENT = "editor.action.commentLine";

function lastCall(): Rule[] {
  return calls[calls.length - 1] as Rule[];
}

describe("applyEditorKeybindingOverrides reconciler", () => {
  beforeEach(() => {
    calls.length = 0;
    __resetAppliedEditorBindingsForTests();
  });

  test("fresh state with no overrides emits no rules (defaults already active)", () => {
    applyEditorKeybindingOverrides([]);
    expect(calls.length).toBe(0);
  });

  test("binding a user key unbinds the default and binds the new key — only for that command", () => {
    applyEditorKeybindingOverrides([{ command: COMMENT, primary: "CmdOrCtrl+Shift+C" }]);

    expect(calls.length).toBe(1);
    const rules = lastCall();
    // Exactly the changed command: one unbind (-id) + one bind (id).
    expect(rules.some((r) => r.command === `-${COMMENT}`)).toBe(true);
    expect(rules.some((r) => r.command === COMMENT)).toBe(true);
    // No other command touched.
    for (const r of rules) {
      expect(r.command.replace(/^-/, "")).toBe(COMMENT);
    }
  });

  test("re-applying the same override is a no-op (idempotent)", () => {
    applyEditorKeybindingOverrides([{ command: COMMENT, primary: "CmdOrCtrl+Shift+C" }]);
    calls.length = 0;
    applyEditorKeybindingOverrides([{ command: COMMENT, primary: "CmdOrCtrl+Shift+C" }]);
    expect(calls.length).toBe(0);
  });

  test("rebinding twice unbinds the PREVIOUS user key, not the original default", () => {
    applyEditorKeybindingOverrides([{ command: COMMENT, primary: "CmdOrCtrl+Shift+C" }]);
    const firstBound = lastCall().find((r) => r.command === COMMENT)?.keybinding;
    expect(firstBound).toBeDefined();

    calls.length = 0;
    applyEditorKeybindingOverrides([{ command: COMMENT, primary: "CmdOrCtrl+Shift+J" }]);
    const rules = lastCall();
    const unbind = rules.find((r) => r.command === `-${COMMENT}`);
    // The unbind targets the keystroke we previously BOUND, so no stale key lingers.
    expect(unbind?.keybinding).toBe(firstBound as number);
  });

  test("unbind (primary:null) removes the default and binds nothing", () => {
    applyEditorKeybindingOverrides([{ command: COMMENT, primary: null }]);
    const rules = lastCall();
    expect(rules.some((r) => r.command === `-${COMMENT}`)).toBe(true);
    expect(rules.some((r) => r.command === COMMENT)).toBe(false);
  });

  test("reset (override removed) restores the default keystroke", () => {
    applyEditorKeybindingOverrides([{ command: COMMENT, primary: "CmdOrCtrl+Shift+C" }]);
    calls.length = 0;
    applyEditorKeybindingOverrides([]); // back to defaults
    const rules = lastCall();
    // Unbind the user key, re-bind the default to the command.
    expect(rules.some((r) => r.command === `-${COMMENT}`)).toBe(true);
    expect(rules.some((r) => r.command === COMMENT)).toBe(true);
  });

  test("overrides for unknown (non-curated) command ids are ignored", () => {
    applyEditorKeybindingOverrides([
      { command: "editor.action.notCurated", primary: "CmdOrCtrl+J" },
    ]);
    expect(calls.length).toBe(0);
  });
});
