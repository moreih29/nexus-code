/**
 * Keys for nexus browser press, as CDP Input.dispatchKeyEvent takes them:
 * "Enter", "Tab", "ctrl-a", "shift-Tab", "a", "meta-z".
 */
import { CliError } from "../context";

/** One key press, ready for Input.dispatchKeyEvent. */
export interface KeyPress {
  readonly key: string;
  readonly code: string;
  readonly keyCode: number;
  /** What the key types; none for a shortcut. */
  readonly text?: string;
  /** CDP's bit field: Alt 1, Ctrl 2, Meta 4, Shift 8. */
  readonly modifiers: number;
  /** Editing commands macOS runs for a shortcut, which synthetic keys do not trigger by themselves. */
  readonly commands?: readonly string[];
}

const MODIFIERS: Record<string, number> = {
  alt: 1,
  option: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
};

interface NamedKey {
  readonly key: string;
  readonly code: string;
  readonly keyCode: number;
  readonly text?: string;
}

const NAMED_KEYS: Record<string, NamedKey> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
};
for (let n = 1; n <= 12; n++)
  NAMED_KEYS[`f${n}`] = { key: `F${n}`, code: `F${n}`, keyCode: 111 + n };

/** The shortcuts macOS turns into editing commands, by key with Meta held. */
const MAC_COMMANDS: Record<string, string> = {
  a: "selectAll",
  c: "copy",
  x: "cut",
  v: "paste",
  z: "undo",
};

export const BROWSER_KEYS_HELP =
  "Keys: Enter Tab Escape Backspace Delete Space Up Down Left Right Home End PageUp PageDown\n" +
  "F1-F12, or one character; held with ctrl-, alt-, shift- or meta- (cmd-), as in ctrl-a.";

function characterKey(char: string): NamedKey {
  if (/^[a-z]$/i.test(char)) {
    return {
      key: char,
      code: `Key${char.toUpperCase()}`,
      keyCode: char.toUpperCase().charCodeAt(0),
      text: char,
    };
  }
  if (/^[0-9]$/.test(char))
    return { key: char, code: `Digit${char}`, keyCode: char.charCodeAt(0), text: char };
  return { key: char, code: "", keyCode: 0, text: char };
}

/** Reads one key as written on the command line; `mac` adds macOS's editing commands. */
export function parseBrowserKey(spec: string, mac: boolean): KeyPress {
  let rest = spec;
  let modifiers = 0;
  for (;;) {
    const match = /^([a-z]+)[-+](.+)$/i.exec(rest);
    const bit = match ? MODIFIERS[(match[1] as string).toLowerCase()] : undefined;
    if (!match || bit === undefined) break;
    modifiers |= bit;
    rest = match[2] as string;
  }
  const named = NAMED_KEYS[rest.toLowerCase()];
  const base = named ?? ([...rest].length === 1 ? characterKey(rest) : undefined);
  if (!base) throw new CliError(`unknown key ${JSON.stringify(spec)}\n${BROWSER_KEYS_HELP}`, 2);

  const shortcut = (modifiers & (1 | 2 | 4)) !== 0;
  let { key, text } = base;
  if (modifiers & 8 && text !== undefined && /^[a-z]$/.test(text)) {
    key = text.toUpperCase();
    text = key;
  }
  const command = mac && modifiers & 4 ? MAC_COMMANDS[base.key.toLowerCase()] : undefined;
  const commands = command === "undo" && modifiers & 8 ? "redo" : command;
  return {
    key,
    code: base.code,
    keyCode: base.keyCode,
    modifiers,
    ...(shortcut || text === undefined ? {} : { text }),
    ...(commands ? { commands: [commands] } : {}),
  };
}
