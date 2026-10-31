import { beforeEach, describe, expect, mock, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import { editorCommandDefault } from "../../../../../../src/shared/keybindings/editor-commands";
import type { AcceleratorString } from "../../../../../../src/shared/keybindings/index";

// ---------------------------------------------------------------------------
// Fake Monaco — resolves keybindings the way Monaco does: its built-in
// bindings, then the rules added through addKeybindingRule, where an unbind
// rule (`-id`) removes only a built-in binding and an added rule goes away
// only when its disposable is disposed. Exact numeric values are arbitrary;
// the tests compare encodings the converter produced.
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

/** Monaco's own bindings. */
let builtins: Rule[] = [];
/** Rules added through addKeybindingRule and not yet disposed. */
let added: Rule[] = [];

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
    addKeybindingRule: (rule: Rule) => {
      added.push(rule);
      return {
        dispose: () => {
          added = added.filter((r) => r !== rule);
        },
      };
    },
  },
} as unknown as typeof Monaco;

mock.module("../../../../../../src/renderer/services/editor/runtime/monaco-singleton", () => ({
  initializeMonacoSingleton: () => {},
  isMonacoReady: () => true,
  onMonacoReady: () => () => {},
  requireMonaco: () => fakeMonaco,
}));

const {
  acceleratorToMonacoKeybinding,
  applyEditorKeybindingOverrides,
  __resetAppliedEditorBindingsForTests,
} = await import("../../../../../../src/renderer/services/editor/keybindings/apply");

const COMMENT = "editor.action.commentLine";
const DEFAULT_KEY = editorCommandDefault(COMMENT) as AcceleratorString;

const kb = (accel: AcceleratorString) => acceleratorToMonacoKeybinding(fakeMonaco, accel) as number;

/** The keystrokes that run `command` now. */
function keysFor(command: string): number[] {
  const unbound = added.filter((r) => r.command === `-${command}`).map((r) => r.keybinding);
  return [
    ...builtins.filter((r) => r.command === command && !unbound.includes(r.keybinding)),
    ...added.filter((r) => r.command === command),
  ].map((r) => r.keybinding);
}

describe("applyEditorKeybindingOverrides reconciler", () => {
  beforeEach(() => {
    builtins = [{ keybinding: kb(DEFAULT_KEY), command: COMMENT }];
    added = [];
    __resetAppliedEditorBindingsForTests();
  });

  test("fresh state with no overrides adds no rules (defaults already active)", () => {
    applyEditorKeybindingOverrides([]);
    expect(added).toEqual([]);
    expect(keysFor(COMMENT)).toEqual([kb(DEFAULT_KEY)]);
  });

  test("binding a user key replaces the default — only for that command", () => {
    applyEditorKeybindingOverrides([{ command: COMMENT, primary: "CmdOrCtrl+Shift+C" }]);

    expect(keysFor(COMMENT)).toEqual([kb("CmdOrCtrl+Shift+C")]);
    for (const r of added) expect(r.command.replace(/^-/, "")).toBe(COMMENT);
  });

  test("re-applying the same override is a no-op (idempotent)", () => {
    applyEditorKeybindingOverrides([{ command: COMMENT, primary: "CmdOrCtrl+Shift+C" }]);
    const before = [...added];
    applyEditorKeybindingOverrides([{ command: COMMENT, primary: "CmdOrCtrl+Shift+C" }]);
    expect(added).toEqual(before);
  });

  test("rebinding twice leaves only the latest key, not the previous user key", () => {
    applyEditorKeybindingOverrides([{ command: COMMENT, primary: "CmdOrCtrl+Shift+C" }]);
    applyEditorKeybindingOverrides([{ command: COMMENT, primary: "CmdOrCtrl+Shift+J" }]);
    expect(keysFor(COMMENT)).toEqual([kb("CmdOrCtrl+Shift+J")]);
  });

  test("unbind (primary:null) removes the default and binds nothing", () => {
    applyEditorKeybindingOverrides([{ command: COMMENT, primary: null }]);
    expect(keysFor(COMMENT)).toEqual([]);
  });

  test("unbinding a user key leaves the command with no key", () => {
    applyEditorKeybindingOverrides([{ command: COMMENT, primary: "CmdOrCtrl+Shift+C" }]);
    applyEditorKeybindingOverrides([{ command: COMMENT, primary: null }]);
    expect(keysFor(COMMENT)).toEqual([]);
  });

  test("reset (override removed) restores the default keystroke alone", () => {
    applyEditorKeybindingOverrides([{ command: COMMENT, primary: "CmdOrCtrl+Shift+C" }]);
    applyEditorKeybindingOverrides([]); // back to defaults
    expect(keysFor(COMMENT)).toEqual([kb(DEFAULT_KEY)]);
    expect(added).toEqual([]);
  });

  test("overrides for unknown (non-curated) command ids are ignored", () => {
    applyEditorKeybindingOverrides([
      { command: "editor.action.notCurated", primary: "CmdOrCtrl+J" },
    ]);
    expect(added).toEqual([]);
  });
});
