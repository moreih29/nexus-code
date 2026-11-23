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
  PageUp: "PageUp",
  PageDown: "PageDown",
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

interface AppliedBinding {
  readonly key: AcceleratorString | null;
  readonly unbindDefault?: { dispose(): void };
  readonly bindUser?: { dispose(): void };
}

const appliedByCommand = new Map<string, AppliedBinding>();

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

export function acceleratorToMonacoKeybinding(
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

export function applyEditorKeybindingOverrides(overrides: readonly KeybindingOverride[]): void {
  if (!isMonacoReady()) return;
  const monaco = requireMonaco();

  const byCommand = new Map<string, KeybindingOverride>();
  for (const o of overrides) {
    if (ALL_EDITOR_COMMAND_IDS.has(o.command)) byCommand.set(o.command, o);
  }

  for (const id of ALL_EDITOR_COMMAND_IDS) {
    const ov = byCommand.get(id);
    const def = editorCommandDefault(id);

    let want: AcceleratorString | null;
    if (ov === undefined || ov.primary === undefined) want = def;
    else want = ov.primary;

    const prev = appliedByCommand.get(id);
    if ((prev ? prev.key : def) === want) continue;

    prev?.bindUser?.dispose();
    if (want === def) {
      prev?.unbindDefault?.dispose();
      appliedByCommand.delete(id);
      continue;
    }

    let unbindDefault = prev?.unbindDefault;
    if (unbindDefault === undefined && def !== null) {
      const kb = acceleratorToMonacoKeybinding(monaco, def);
      if (kb !== null) {
        unbindDefault = monaco.editor.addKeybindingRule({ keybinding: kb, command: `-${id}` });
      }
    }
    let bindUser: { dispose(): void } | undefined;
    if (want !== null) {
      const kb = acceleratorToMonacoKeybinding(monaco, want);
      if (kb !== null) bindUser = monaco.editor.addKeybindingRule({ keybinding: kb, command: id });
      else log.warn(`editor keybinding for ${id} is not Monaco-encodable: ${want}`);
    }
    appliedByCommand.set(id, {
      key: want,
      ...(unbindDefault !== undefined ? { unbindDefault } : {}),
      ...(bindUser !== undefined ? { bindUser } : {}),
    });
  }
}

export function __resetAppliedEditorBindingsForTests(): void {
  appliedByCommand.clear();
}
