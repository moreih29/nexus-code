import { beforeEach, describe, expect, mock, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import {
  __resetCommandsForTests,
  registerCommand,
} from "../../../../../../src/renderer/commands/registry";
import { COMMANDS } from "../../../../../../src/shared/keybindings/commands";
import { KEYBINDINGS } from "../../../../../../src/shared/keybindings/index";
import { applyKeybindingOverrides } from "../../../../../../src/shared/keybindings/overrides";

// ---------------------------------------------------------------------------
// Fake Monaco — keeps the rules added through addKeybindingRule until their
// disposable is disposed, and captures registerCommand calls. As in
// apply.test.ts the monaco-singleton is stubbed via mock.module and the
// subject is imported after it, so it binds to this fake.
// ---------------------------------------------------------------------------

interface Rule {
  keybinding: number;
  command: string;
}

/** Rules added and not yet disposed. */
let added: Rule[] = [];
let addCount = 0;
const commands = new Map<string, () => void>();

const KeyMod = {
  CtrlCmd: 1 << 11,
  Shift: 1 << 10,
  Alt: 1 << 9,
  WinCtrl: 1 << 8,
  chord: (first: number, second: number) => first * 0x10000 + second,
};

const KeyCode = new Proxy(
  {},
  {
    get(_t, prop: string) {
      let h = 0;
      for (let i = 0; i < prop.length; i++) h = (h * 31 + prop.charCodeAt(i)) & 0xff;
      return h | 0x1000;
    },
  },
) as unknown as typeof Monaco.KeyCode;

const fakeMonaco = {
  KeyMod,
  KeyCode,
  editor: {
    addKeybindingRule: (rule: Rule) => {
      added.push(rule);
      addCount += 1;
      return {
        dispose: () => {
          added = added.filter((r) => r !== rule);
        },
      };
    },
    registerCommand: (id: string, handler: () => void) => {
      commands.set(id, handler);
      return { dispose: () => {} };
    },
  },
} as unknown as typeof Monaco;

mock.module("../../../../../../src/renderer/services/editor/runtime/monaco-singleton", () => ({
  initializeMonacoSingleton: () => {},
  isMonacoReady: () => true,
  onMonacoReady: () => () => {},
  requireMonaco: () => fakeMonaco,
}));

const { applyAppChordsToMonaco, appChordMonacoCommand, __resetAppliedAppChordsForTests } =
  await import("../../../../../../src/renderer/services/editor/keybindings/app-chords");

const KNOWN = new Set(Object.values(COMMANDS) as string[]);
const effective = (overrides: Parameters<typeof applyKeybindingOverrides>[1]) =>
  applyKeybindingOverrides(KEYBINDINGS, overrides, KNOWN);

const CHORD_COMMANDS = [COMMANDS.tabCloseSaved, COMMANDS.tabCloseAll, COMMANDS.tabPinToggle];

describe("applyAppChordsToMonaco", () => {
  beforeEach(() => {
    added = [];
    addCount = 0;
    commands.clear();
    __resetAppliedAppChordsForTests();
    __resetCommandsForTests();
  });

  test("binds every app chord in Monaco to a command that runs the app command", () => {
    applyAppChordsToMonaco(KEYBINDINGS);
    expect(added.map((r) => r.command).sort()).toEqual(
      CHORD_COMMANDS.map(appChordMonacoCommand).sort(),
    );

    const run = mock(() => {});
    registerCommand(COMMANDS.tabCloseAll, run);
    commands.get(appChordMonacoCommand(COMMANDS.tabCloseAll))?.();
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("encodes Ctrl+K U as a Monaco chord", () => {
    applyAppChordsToMonaco(KEYBINDINGS);
    const rule = added.find((r) => r.command === appChordMonacoCommand(COMMANDS.tabCloseSaved));
    const ctrlK = KeyMod.CtrlCmd | (KeyCode as unknown as Record<string, number>).KeyK;
    const u = (KeyCode as unknown as Record<string, number>).KeyU;
    expect(rule?.keybinding).toBe(KeyMod.chord(ctrlK, u));
  });

  test("is idempotent", () => {
    applyAppChordsToMonaco(KEYBINDINGS);
    applyAppChordsToMonaco(KEYBINDINGS);
    expect(addCount).toBe(CHORD_COMMANDS.length);
  });

  test("a rebound chord drops the old keystroke and binds the new one", () => {
    const id = appChordMonacoCommand(COMMANDS.tabCloseAll);
    applyAppChordsToMonaco(KEYBINDINGS);
    const old = added.find((r) => r.command === id)?.keybinding;
    applyAppChordsToMonaco(
      effective([{ command: COMMANDS.tabCloseAll, chord: ["CmdOrCtrl+K", "CmdOrCtrl+Q"] }]),
    );
    const now = added.filter((r) => r.command === id);
    expect(now).toHaveLength(1);
    expect(now[0]?.keybinding).not.toBe(old as number);
  });

  test("an unbound chord is removed from Monaco", () => {
    applyAppChordsToMonaco(KEYBINDINGS);
    applyAppChordsToMonaco(effective([{ command: COMMANDS.tabPinToggle, chord: null }]));
    const id = appChordMonacoCommand(COMMANDS.tabPinToggle);
    expect(added.some((r) => r.command === id)).toBe(false);
  });

  test("registers each Monaco command once", () => {
    applyAppChordsToMonaco(KEYBINDINGS);
    const first = commands.get(appChordMonacoCommand(COMMANDS.tabCloseAll));
    applyAppChordsToMonaco(
      effective([{ command: COMMANDS.tabCloseAll, chord: ["CmdOrCtrl+K", "CmdOrCtrl+Q"] }]),
    );
    expect(commands.get(appChordMonacoCommand(COMMANDS.tabCloseAll))).toBe(first);
  });
});
