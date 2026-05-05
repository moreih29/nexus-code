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

import type { AcceleratorString } from "./keybindings";

export interface ParsedKeystroke {
  /**
   * `CmdOrCtrl` token. Matches `metaKey` on Mac or `ctrlKey` on
   * Win/Linux. The dispatcher accepts either via `(meta || ctrl)`
   * so a single declaration covers both platforms.
   */
  cmd: boolean;
  shift: boolean;
  alt: boolean;
  /**
   * Acceptable `KeyboardEvent.code` values. Usually a single entry.
   * Backslash is special-cased to also accept `Slash`: Korean
   * keyboards type the slash key for what would be backslash on QWERTY,
   * and we want our split shortcut (⌘\) to fire on both.
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
  let shift = false;
  let alt = false;
  let codes: readonly string[] | null = null;

  for (const tok of tokens) {
    if (MOD_TOKENS_CMD_OR_CTRL.has(tok) || MOD_TOKENS_CMD.has(tok) || MOD_TOKENS_CTRL.has(tok)) {
      cmd = true;
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
  return { cmd, shift, alt, codes };
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
      // Korean keyboard parity: Shift+Backslash on a US layout sends
      // KeyboardEvent.code === "Backslash"; the same physical key on
      // a Korean layout often surfaces as "Slash". Accepting both
      // keeps `⌘\` working for everyone without per-layout config.
      return ["Backslash", "Slash"];
    case "/":
      return ["Slash"];
    case "Backslash":
      return ["Backslash"];
    case "Slash":
      return ["Slash"];
    case "Comma":
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
      throw new Error(`unsupported accelerator token: ${tok}`);
  }
}

/**
 * True when `e` matches the parsed keystroke. The match is strict on
 * modifiers — `parseAccelerator("Shift+Enter")` rejects `⌘⇧Enter`
 * (extra Cmd) — so two bindings can coexist with overlapping keys but
 * different modifier sets.
 *
 * Cmd vs Ctrl is treated as the same physical modifier (`metaKey ||
 * ctrlKey`) so a single `CmdOrCtrl+W` declaration works on every
 * platform without branching.
 */
export function matchesEvent(p: ParsedKeystroke, e: KeyboardEvent): boolean {
  if (!p.codes.includes(e.code)) return false;
  // Reject "both Cmd and Ctrl pressed" — ambiguous and not what users
  // mean by either alone.
  if (e.metaKey && e.ctrlKey) return false;
  const cmdActive = e.metaKey || e.ctrlKey;
  if (p.cmd !== cmdActive) return false;
  if (p.shift !== e.shiftKey) return false;
  if (p.alt !== e.altKey) return false;
  return true;
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
