/**
 * Pure parsers for accelerator strings (Electron's format).
 *
 * Two consumers:
 *   - The renderer dispatcher uses {@link parseAccelerator} +
 *     {@link matchesEvent} to detect when a `KeyboardEvent` satisfies
 *     a binding declaration.
 *   - Both renderer (context menu shortcut hints) and main (chord
 *     label suffixes) use {@link acceleratorToLabel} to render the
 *     binding for users.
 *
 * No DOM, no React, no Electron — these helpers stay pure so they're
 * cheap to unit-test and reuse on either side of the IPC boundary.
 */

import type { AcceleratorString } from "./index";

export interface ParsedKeystroke {
  /**
   * `CmdOrCtrl` or explicit `Cmd`/`Command`/`Meta`. Matches `metaKey`
   * on Mac or `ctrlKey` on Win/Linux for `CmdOrCtrl`; matches `metaKey`
   * specifically for explicit `Cmd` (only meaningful on Mac).
   *
   * When `ctrl` is also true, this becomes a literal "Cmd AND Ctrl"
   * combo (Mac-only realistic; the dispatcher then requires both
   * `metaKey` and `ctrlKey`).
   */
  cmd: boolean;
  /**
   * Explicit `Ctrl`/`Control` token. Matches `ctrlKey` strictly. Used
   * for combos like `Cmd+Ctrl+Up` where we need to distinguish the two
   * physical modifiers on Mac. Bare `Ctrl+X` (without `Cmd`) means
   * "Control + X" literally, not "CmdOrCtrl + X" — use `CmdOrCtrl`
   * for the cross-platform shorthand.
   */
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /**
   * Acceptable `KeyboardEvent.code` values. Usually a single entry.
   * `code` identifies the physical key independent of keyboard layout
   * (a Korean layout's ₩/\ key still reports "Backslash"), so one code
   * per token is sufficient — do NOT add sibling codes for layout
   * parity, or unrelated shortcuts (e.g. ⌘/ comment toggle) get
   * swallowed by the wrong binding.
   */
  codes: readonly string[];
}

const MOD_TOKENS_CMD_OR_CTRL = new Set(["CmdOrCtrl", "CommandOrControl"]);
const MOD_TOKENS_CMD = new Set(["Cmd", "Command", "Meta"]);
const MOD_TOKENS_CTRL = new Set(["Ctrl", "Control"]);
const MOD_TOKENS_SHIFT = new Set(["Shift"]);
const MOD_TOKENS_ALT = new Set(["Alt", "Option"]);

export function parseAccelerator(accel: AcceleratorString): ParsedKeystroke {
  const tokens = accel.split("+").map((t) => t.trim());
  if (tokens.length === 0) throw new Error(`empty accelerator: ${JSON.stringify(accel)}`);

  let cmd = false;
  let ctrl = false;
  let shift = false;
  let alt = false;
  let codes: readonly string[] | null = null;

  for (const tok of tokens) {
    if (MOD_TOKENS_CMD_OR_CTRL.has(tok) || MOD_TOKENS_CMD.has(tok)) {
      cmd = true;
    } else if (MOD_TOKENS_CTRL.has(tok)) {
      ctrl = true;
    } else if (MOD_TOKENS_SHIFT.has(tok)) {
      shift = true;
    } else if (MOD_TOKENS_ALT.has(tok)) {
      alt = true;
    } else {
      if (codes !== null) {
        throw new Error(`accelerator ${JSON.stringify(accel)} has multiple key tokens`);
      }
      codes = tokenToCodes(tok);
    }
  }

  if (codes === null) {
    throw new Error(`accelerator ${JSON.stringify(accel)} has no key token`);
  }
  return { cmd, ctrl, shift, alt, codes };
}

function tokenToCodes(tok: string): readonly string[] {
  if (tok.length === 1 && /[A-Za-z]/.test(tok)) {
    return [`Key${tok.toUpperCase()}`];
  }
  if (tok.length === 1 && /[0-9]/.test(tok)) {
    return [`Digit${tok}`];
  }
  switch (tok) {
    case "Enter":
    case "Return":
      return ["Enter"];
    case "Escape":
    case "Esc":
      return ["Escape"];
    case "Tab":
      return ["Tab"];
    case "Space":
      return ["Space"];
    case "Backspace":
      return ["Backspace"];
    case "Delete":
      return ["Delete"];
    case "Up":
      return ["ArrowUp"];
    case "Down":
      return ["ArrowDown"];
    case "Left":
      return ["ArrowLeft"];
    case "Right":
      return ["ArrowRight"];
    case "\\":
      // KeyboardEvent.code is layout-independent: Korean layouts also
      // report the ₩/\ physical key as "Backslash" (only e.key differs).
      // This previously returned ["Backslash", "Slash"] for a mistaken
      // "Korean keyboard parity" reason, which made ⌘/ trigger the ⌘\
      // split shortcut and swallow Monaco's comment toggle.
      return ["Backslash"];
    case "/":
      return ["Slash"];
    case "Backslash":
      return ["Backslash"];
    case "Slash":
      return ["Slash"];
    case "Comma":
    case ",":
      return ["Comma"];
    case "Period":
      return ["Period"];
    case "Semicolon":
      return ["Semicolon"];
    case "Quote":
      return ["Quote"];
    case "BracketLeft":
    case "[":
      return ["BracketLeft"];
    case "BracketRight":
    case "]":
      return ["BracketRight"];
    case "Minus":
    case "-":
      return ["Minus"];
    case "Equal":
    case "=":
      return ["Equal"];
    case "Backquote":
    case "`":
      return ["Backquote"];
    default:
      // F1-F12 function keys: code === key === "F1", "F2", …
      if (/^F[1-9]$|^F1[0-2]$/.test(tok)) return [tok];
      throw new Error(`unsupported accelerator token: ${tok}`);
  }
}

/**
 * True when `e` matches the parsed keystroke. The match is strict on
 * modifiers — `parseAccelerator("Shift+Enter")` rejects `⌘⇧Enter`
 * (extra Cmd) — so two bindings can coexist with overlapping keys but
 * different modifier sets.
 *
 * `isMac` resolves the platform meaning of the `CmdOrCtrl` shorthand:
 *   - On Mac, `CmdOrCtrl+R` matches **only** ⌘R; bare ⌃R passes through
 *     so terminal apps (xterm) keep their Ctrl-letter shortcuts like
 *     `Ctrl+R` (reverse-i-search), `Ctrl+W` (delete-word), `Ctrl+T`
 *     (transpose). Holding both ⌘ and ⌃ is still rejected — that
 *     ambiguous combo is reserved for explicit `Cmd+Ctrl+...` bindings.
 *   - On Win/Linux, `CmdOrCtrl+R` matches **only** Ctrl+R (metaKey is
 *     usually the Windows/Super key and not part of our shortcut set).
 *
 * Modifier matrix:
 *   - `cmd && ctrl` (literal Cmd+Ctrl combo, Mac-only realistically):
 *     requires `metaKey && ctrlKey`.
 *   - `cmd && !ctrl` (CmdOrCtrl shorthand): Mac → `metaKey && !ctrlKey`;
 *     non-Mac → `ctrlKey && !metaKey`.
 *   - `!cmd && ctrl` (literal Ctrl-only): `ctrlKey && !metaKey` on every
 *     platform — used by bindings that genuinely mean "Control".
 *   - `!cmd && !ctrl`: neither modifier pressed.
 */
/**
 * Platform-agnostic key state — the subset of modifiers + physical code
 * that {@link matchesKeyState} needs. A DOM `KeyboardEvent` and an
 * Electron `before-input-event` Input both reduce to this shape, so the
 * single matcher serves the renderer dispatcher AND the main-process
 * browser-view key interceptor (WebContentsView keystrokes never reach
 * the renderer document — see main/features/browser/keyboard.ts).
 */
export interface KeyChordState {
  code: string;
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

/** Core matcher — see {@link matchesEvent} for the modifier matrix rationale. */
export function matchesKeyState(p: ParsedKeystroke, s: KeyChordState, isMac: boolean): boolean {
  if (!p.codes.includes(s.code)) return false;

  if (p.cmd && p.ctrl) {
    if (!(s.meta && s.ctrl)) return false;
  } else if (p.cmd) {
    // CmdOrCtrl shorthand: pick the platform's "primary" modifier and
    // require the other to be absent. The "absent" side matters most on
    // Mac, where bare ⌃-letter shortcuts belong to the terminal/shell.
    if (isMac) {
      if (!s.meta || s.ctrl) return false;
    } else {
      if (!s.ctrl || s.meta) return false;
    }
  } else if (p.ctrl) {
    if (!s.ctrl || s.meta) return false;
  } else {
    if (s.meta || s.ctrl) return false;
  }

  if (p.shift !== s.shift) return false;
  if (p.alt !== s.alt) return false;
  return true;
}

export function matchesEvent(p: ParsedKeystroke, e: KeyboardEvent, isMac: boolean): boolean {
  return matchesKeyState(
    p,
    { code: e.code, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey },
    isMac,
  );
}

// ---------------------------------------------------------------------------
// Event → accelerator (the recorder's reverse function)
// ---------------------------------------------------------------------------

/** Inverse of `tokenToCodes` for the codes we support. */
const CODE_TO_TOKEN: Readonly<Record<string, string>> = {
  Enter: "Enter",
  Escape: "Escape",
  Tab: "Tab",
  Space: "Space",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Backslash: "\\",
  Slash: "/",
  Comma: ",",
  Period: "Period",
  Semicolon: "Semicolon",
  Quote: "Quote",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

/**
 * Convert a captured KeyboardEvent into the accelerator string that
 * would match it — the keybinding recorder's reverse of
 * `parseAccelerator` + `matchesEvent`. Round-trip invariant:
 * `matchesEvent(parseAccelerator(eventToAccelerator(e)!), e, isMac)`
 * is true whenever the result is non-null.
 *
 * Returns `null` when the event cannot form a valid binding:
 *   - modifier-only keydowns (the recorder shows them as "pending");
 *   - physical keys outside our token table (media keys, NumPad, …);
 *   - the platform-foreign primary modifier (bare Win/Super key
 *     combos on non-Mac — `metaKey` there is not part of our
 *     accelerator vocabulary).
 *
 * Modifier mapping mirrors `matchesEvent`'s matrix:
 *   - Mac:  meta → `CmdOrCtrl`, ctrl alone → `Ctrl` (literal),
 *           meta+ctrl → `Cmd+Ctrl` (literal two-modifier combo).
 *   - Win/Linux: ctrl → `CmdOrCtrl`; metaKey set → null.
 */
export function eventToAccelerator(e: KeyboardEvent, isMac: boolean): string | null {
  const token = codeToToken(e.code);
  if (token === null) return null;

  const mods: string[] = [];
  if (isMac) {
    if (e.metaKey && e.ctrlKey) {
      mods.push("Cmd", "Ctrl");
    } else if (e.metaKey) {
      mods.push("CmdOrCtrl");
    } else if (e.ctrlKey) {
      mods.push("Ctrl");
    }
  } else {
    if (e.metaKey) return null; // Win/Super combos are not bindable
    if (e.ctrlKey) mods.push("CmdOrCtrl");
  }
  if (e.shiftKey) mods.push("Shift");
  if (e.altKey) mods.push("Alt");

  return [...mods, token].join("+");
}

function codeToToken(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter !== null) return letter[1] as string;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit !== null) return digit[1] as string;
  if (/^F[1-9]$|^F1[0-2]$/.test(code)) return code;
  return CODE_TO_TOKEN[code] ?? null;
}

/** True when `e.code` is itself a modifier key (⇧⌃⌥⌘ keydowns). */
export function isModifierCode(code: string): boolean {
  return /^(Shift|Control|Alt|Meta)(Left|Right)?$/.test(code) || code === "CapsLock";
}

/**
 * Reduce an accelerator to a platform-resolved canonical key, e.g.
 * `"meta+shift+KeyR"` (Mac) / `"ctrl+shift+KeyR"` (Win/Linux) for
 * `"CmdOrCtrl+Shift+R"`. Two accelerators with the same normalized form
 * match exactly the same KeyboardEvents under `matchesEvent` — this is
 * the equality the conflict engine and reserved-key catalog compare on.
 *
 * Returns `null` for unparseable input instead of throwing, so callers
 * probing user-typed strings don't need their own try/catch.
 */
export function normalizeKeystroke(accel: AcceleratorString, isMac: boolean): string | null {
  let p: ParsedKeystroke;
  try {
    p = parseAccelerator(accel);
  } catch {
    return null;
  }
  const mods: string[] = [];
  if (p.cmd && p.ctrl) {
    mods.push("meta", "ctrl"); // literal two-modifier combo
  } else if (p.cmd) {
    mods.push(isMac ? "meta" : "ctrl"); // CmdOrCtrl shorthand resolution
  } else if (p.ctrl) {
    mods.push("ctrl");
  }
  if (p.shift) mods.push("shift");
  if (p.alt) mods.push("alt");
  return [...mods, p.codes[0]].join("+");
}

interface LabelOptions {
  isMac: boolean;
}

/**
 * Render an accelerator string as a user-facing label. Mac uses the
 * symbol forms (⌘ ⌥ ⇧ ⌃ ↵ ↑↓←→); Win/Linux fall back to spelled
 * modifiers joined with `+`.
 */
export function acceleratorToLabel(accel: AcceleratorString, opts: LabelOptions): string {
  const tokens = accel.split("+").map((t) => t.trim());
  const out: string[] = [];
  for (const tok of tokens) {
    if (MOD_TOKENS_CMD_OR_CTRL.has(tok)) {
      out.push(opts.isMac ? "⌘" : "Ctrl");
    } else if (MOD_TOKENS_CMD.has(tok)) {
      out.push("⌘");
    } else if (MOD_TOKENS_CTRL.has(tok)) {
      out.push(opts.isMac ? "⌃" : "Ctrl");
    } else if (MOD_TOKENS_SHIFT.has(tok)) {
      out.push(opts.isMac ? "⇧" : "Shift");
    } else if (MOD_TOKENS_ALT.has(tok)) {
      out.push(opts.isMac ? "⌥" : "Alt");
    } else {
      out.push(keyTokenToLabel(tok, opts));
    }
  }
  return opts.isMac ? out.join("") : out.join("+");
}

function keyTokenToLabel(tok: string, opts: LabelOptions): string {
  if (opts.isMac) {
    switch (tok) {
      case "Up":
        return "↑";
      case "Down":
        return "↓";
      case "Left":
        return "←";
      case "Right":
        return "→";
      case "Enter":
      case "Return":
        return "↵";
    }
  }
  switch (tok) {
    case "Comma":
    case ",":
      return ",";
    case "Period":
    case ".":
      return ".";
  }
  if (tok.length === 1) return tok.toUpperCase();
  return tok;
}

/**
 * Render a chord (two-step) keybinding as a single label, joining the
 * two halves with a space — `⌘K ⌘W` on Mac, `Ctrl+K Ctrl+W` elsewhere.
 */
export function chordToLabel(
  chord: readonly [AcceleratorString, AcceleratorString],
  opts: LabelOptions,
): string {
  return chord.map((c) => acceleratorToLabel(c, opts)).join(" ");
}
