/**
 * Apply user editor-keybinding overrides to Monaco's keybinding service.
 *
 * Monaco offers `monaco.editor.addKeybindingRules(rules)` to layer
 * keybindings over the built-in defaults: a rule binds a keystroke to a
 * command id, or UNBINDS it when the command is prefixed with `-`.
 * There is no public API to clear previously-added rules — they
 * accumulate for the lifetime of the renderer. So a naïve "re-apply the
 * whole override set" would leave stale keystrokes firing after a second
 * rebind.
 *
 * This module is therefore a small RECONCILER: it tracks, per command,
 * the keystroke currently bound (a user accelerator or the declared
 * default), and on each apply emits only the delta — unbind the old
 * keystroke, bind the new — so live changes settle cleanly without an
 * app restart. The tracking map is module-scoped (one Monaco instance
 * per renderer window).
 *
 * Accelerators are converted to Monaco's numeric keybinding encoding
 * (KeyMod | KeyCode); chords are out of scope for editor commands (all
 * curated entries are single-stroke), so only `primary` is honored.
 */

import {
  ALL_EDITOR_COMMAND_IDS,
  editorCommandDefault,
} from "../../../../shared/keybindings/editor-commands";
import type { AcceleratorString } from "../../../../shared/keybindings/index";
import { parseAccelerator } from "../../../../shared/keybindings/keybinding-parse";
import type { KeybindingOverride } from "../../../../shared/keybindings/overrides";
import { createLogger } from "../../../../shared/log/renderer";
import { isMonacoReady, requireMonaco } from "../runtime/monaco-singleton";

const log = createLogger("editor-keybindings");

// KeyboardEvent.code → Monaco KeyCode enum member name, for the
// non-alphanumeric / non-function keys. KeyA-Z, Digit0-9 and F1-F12
// share their `code` string with the Monaco enum name and are handled
// by regex below.
const CODE_TO_KEYCODE_NAME: Readonly<Record<string, string>> = {
  Enter: "Enter",
  Escape: "Escape",
  Tab: "Tab",
  Space: "Space",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "UpArrow",
  ArrowDown: "DownArrow",
  ArrowLeft: "LeftArrow",
  ArrowRight: "RightArrow",
  Backslash: "Backslash",
  Slash: "Slash",
  Comma: "Comma",
  Period: "Period",
  Semicolon: "Semicolon",
  Quote: "Quote",
  BracketLeft: "BracketLeft",
  BracketRight: "BracketRight",
  Minus: "Minus",
  Equal: "Equal",
  Backquote: "Backquote",
};

/** What keystroke each editor command is currently bound to in Monaco. */
const appliedByCommand = new Map<string, AcceleratorString | null>();

function codeToMonacoKeyCode(monaco: typeof import("monaco-editor"), code: string): number | null {
  let name: string | undefined;
  if (/^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code) || /^F([1-9]|1[0-2])$/.test(code)) {
    name = code;
  } else {
    name = CODE_TO_KEYCODE_NAME[code];
  }
  if (name === undefined) return null;
  const value = (monaco.KeyCode as unknown as Record<string, number>)[name];
  return typeof value === "number" ? value : null;
}

/**
 * Convert an accelerator string to Monaco's numeric keybinding encoding.
 * Returns null for anything Monaco can't express (modifier-only, unknown
 * key). `CmdOrCtrl` maps to `KeyMod.CtrlCmd`, which Monaco resolves to ⌘
 * on Mac / Ctrl elsewhere — the same platform semantics our parser uses.
 */
function acceleratorToMonacoKeybinding(
  monaco: typeof import("monaco-editor"),
  accel: AcceleratorString,
): number | null {
  let p: ReturnType<typeof parseAccelerator>;
  try {
    p = parseAccelerator(accel);
  } catch {
    return null;
  }
  const code = p.codes[0];
  if (code === undefined) return null;
  const keyCode = codeToMonacoKeyCode(monaco, code);
  if (keyCode === null) return null;

  let mods = 0;
  if (p.cmd) mods |= monaco.KeyMod.CtrlCmd;
  if (p.ctrl) mods |= monaco.KeyMod.WinCtrl;
  if (p.shift) mods |= monaco.KeyMod.Shift;
  if (p.alt) mods |= monaco.KeyMod.Alt;
  return mods | keyCode;
}

/**
 * Reconcile Monaco's keybindings to match the given editor overrides.
 * Idempotent: emits only the delta versus what was last applied, so
 * calling repeatedly (live edit, cross-window broadcast) never piles up
 * duplicate bindings. No-op until Monaco is initialized — the caller
 * (initializeEditorServices) re-invokes once it is.
 */
export function applyEditorKeybindingOverrides(overrides: readonly KeybindingOverride[]): void {
  if (!isMonacoReady()) return;
  const monaco = requireMonaco();

  const byCommand = new Map<string, KeybindingOverride>();
  for (const o of overrides) {
    if (ALL_EDITOR_COMMAND_IDS.has(o.command)) byCommand.set(o.command, o);
  }

  const rules: { keybinding: number; command: string }[] = [];

  for (const id of ALL_EDITOR_COMMAND_IDS) {
    const ov = byCommand.get(id);
    const def = editorCommandDefault(id);

    // Desired end state for this command: the user's keystroke, an
    // explicit unbind, or the built-in default.
    let want: AcceleratorString | null;
    if (ov === undefined || ov.primary === undefined) want = def;
    else want = ov.primary; // string = replace, null = unbind

    const prev = appliedByCommand.has(id) ? (appliedByCommand.get(id) ?? null) : def;
    if (prev === want) continue;

    if (prev !== null) {
      const kb = acceleratorToMonacoKeybinding(monaco, prev);
      if (kb !== null) rules.push({ keybinding: kb, command: `-${id}` });
    }
    if (want !== null) {
      const kb = acceleratorToMonacoKeybinding(monaco, want);
      if (kb !== null) rules.push({ keybinding: kb, command: id });
      else log.warn(`editor keybinding for ${id} is not Monaco-encodable: ${want}`);
    }
    appliedByCommand.set(id, want);
  }

  if (rules.length > 0) monaco.editor.addKeybindingRules(rules);
}

/** Test-only: forget what has been applied so a fresh reconcile starts clean. */
export function __resetAppliedEditorBindingsForTests(): void {
  appliedByCommand.clear();
}
