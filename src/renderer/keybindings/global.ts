/**
 * Global keyboard shortcut → command-id router.
 *
 * Reads its bindings from `shared/keybindings.ts`. Every entry there
 * becomes one of:
 *   - a single-keystroke binding (entry has `primary`)
 *   - a chord binding (entry has `chord: [leader, secondary]`)
 *
 * The dispatcher matches the incoming `KeyboardEvent` against the
 * compiled predicates and routes the resolved command to
 * `executeCommand`. Implementation lives in
 * `use-global-keybindings.ts`; this file is dispatch-only.
 *
 * The chord state machine is local to this module:
 *   - On a leader match, set `pending` for `CHORD_TIMEOUT_MS`.
 *   - On the next event, try to complete the chord. Match fires the
 *     command; mismatch (or Escape) clears pending silently.
 *   - Modifier-only keydown events (`Meta` / `Control` / `Shift` /
 *     `Alt` alone) do not disturb pending — releasing/re-pressing
 *     `⌘` between leader and second key is normal user behaviour.
 *
 * Phase 2 (planned) will further split this file into
 * resolver / state / listener modules and switch the listener to
 * capture phase. Phase 3 will introduce `when` context expressions
 * to replace the binary `guardEditable` flag.
 */

import {
  acceleratorToLabel,
  chordToLabel,
  matchesEvent,
  type ParsedKeystroke,
  parseAccelerator,
} from "../../shared/keybinding-parse";
import { type KeybindingDecl, KEYBINDINGS } from "../../shared/keybindings";
import { executeCommand } from "../commands/registry";

// ---------------------------------------------------------------------------
// Compile declarations once at module load
// ---------------------------------------------------------------------------

interface CompiledPrimary {
  decl: KeybindingDecl;
  parsed: ParsedKeystroke;
}

interface CompiledChord {
  decl: KeybindingDecl;
  leader: ParsedKeystroke;
  secondary: ParsedKeystroke;
  /** Stable id for the leader keystroke — chord bindings sharing the
   *  same leader text share the same id, which is how we filter
   *  secondary candidates while pending. */
  leaderId: string;
}

const PRIMARIES: CompiledPrimary[] = [];
const CHORDS: CompiledChord[] = [];

for (const decl of KEYBINDINGS) {
  if (decl.primary !== undefined) {
    PRIMARIES.push({ decl, parsed: parseAccelerator(decl.primary) });
  }
  if (decl.chord !== undefined) {
    CHORDS.push({
      decl,
      leader: parseAccelerator(decl.chord[0]),
      secondary: parseAccelerator(decl.chord[1]),
      leaderId: decl.chord[0],
    });
  }
}

// ---------------------------------------------------------------------------
// Editable detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the event target is an editable element where global
 * shortcuts should not fire (input, textarea, contenteditable, inside
 * a CodeMirror editor, or inside a Monaco editor).
 *
 * Exported for unit testing.
 */
export function isInEditable(target: HTMLElement | null): boolean {
  return (
    target?.tagName === "INPUT" ||
    target?.tagName === "TEXTAREA" ||
    target?.isContentEditable === true ||
    target?.closest(".cm-editor") != null ||
    target?.closest(".monaco-editor") != null
  );
}

// ---------------------------------------------------------------------------
// Chord state
// ---------------------------------------------------------------------------

const CHORD_TIMEOUT_MS = 1500;

interface PendingChord {
  leaderId: string;
  expiresAt: number;
}

let pending: PendingChord | null = null;

let nowMs: () => number = () => Date.now();

export function __setChordClockForTests(fn: () => number): void {
  nowMs = fn;
}

export function __resetChordStateForTests(): void {
  pending = null;
  nowMs = () => Date.now();
}

const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt", "OS", "Hyper", "Super"]);

function isModifierKeyOnly(e: KeyboardEvent): boolean {
  return MODIFIER_KEYS.has(e.key);
}

// ---------------------------------------------------------------------------
// Debug logging — temporary, will be removed once chord pipeline is
// stable in dev. Lines are greppable in DevTools console as `[chord]`.
// ---------------------------------------------------------------------------

function debugLog(...args: unknown[]): void {
  console.log("[chord]", ...args);
}

function describeEvent(e: KeyboardEvent): string {
  const mods = [
    e.metaKey ? "meta" : null,
    e.ctrlKey ? "ctrl" : null,
    e.altKey ? "alt" : null,
    e.shiftKey ? "shift" : null,
  ]
    .filter(Boolean)
    .join("+");
  return `key=${JSON.stringify(e.key)} code=${e.code}${mods ? ` mods=${mods}` : ""}`;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function tryCompleteChord(e: KeyboardEvent): boolean {
  if (!pending) return false;
  if (nowMs() > pending.expiresAt) {
    debugLog("pending expired, clearing", { leader: pending.leaderId });
    pending = null;
    return false;
  }
  // Modifier-only keydowns happen frequently while the user holds /
  // releases ⌘ between leader and second key. Don't let them clear
  // the pending state.
  if (isModifierKeyOnly(e)) return false;

  // Escape during pending cancels silently. Matches VSCode.
  if (e.key === "Escape" && !e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey) {
    debugLog("Escape during pending → cancel");
    pending = null;
    e.preventDefault();
    return true;
  }

  for (const c of CHORDS) {
    if (c.leaderId !== pending.leaderId) continue;
    if (!matchesEvent(c.secondary, e)) continue;
    if (
      c.decl.guardEditable !== false &&
      isInEditable(e.target as HTMLElement | null)
    ) {
      debugLog("second matched but in editable → swallow", { command: c.decl.command });
      pending = null;
      return true;
    }
    debugLog("chord completed → dispatch", { command: c.decl.command });
    e.preventDefault();
    executeCommand(c.decl.command);
    pending = null;
    return true;
  }

  // Pending was active but the second key didn't match any chord.
  // Swallow the keystroke so a stray letter doesn't accidentally type
  // into the surrounding UI, and clear the chord. Matches VSCode.
  debugLog("pending active but second key did not match — swallow + clear", describeEvent(e));
  pending = null;
  e.preventDefault();
  return true;
}

function tryEnterChord(e: KeyboardEvent): boolean {
  for (const c of CHORDS) {
    if (!matchesEvent(c.leader, e)) continue;
    if (c.decl.guardEditable !== false && isInEditable(e.target as HTMLElement | null)) {
      debugLog("leader matched but in editable → ignore", { leader: c.leaderId });
      return false;
    }
    debugLog("leader → pending", { leader: c.leaderId, expiresInMs: CHORD_TIMEOUT_MS });
    e.preventDefault();
    pending = { leaderId: c.leaderId, expiresAt: nowMs() + CHORD_TIMEOUT_MS };
    return true;
  }
  return false;
}

export function handleGlobalKeyDown(e: KeyboardEvent): void {
  debugLog("keydown", describeEvent(e), { hasPending: pending !== null });

  // 1) Pending chord takes priority.
  if (tryCompleteChord(e)) return;

  // 2) Single-keystroke bindings.
  for (const p of PRIMARIES) {
    if (!matchesEvent(p.parsed, e)) continue;
    if (p.decl.guardEditable !== false && isInEditable(e.target as HTMLElement | null)) {
      // The decl opted out of the editable guard (e.g. files.refresh)
      // → keep going; otherwise bail silently.
      return;
    }
    debugLog("single match → dispatch", { command: p.decl.command });
    e.preventDefault();
    executeCommand(p.decl.command);
    return;
  }

  // 3) Chord leader — enter pending state without dispatching.
  if (!tryEnterChord(e)) {
    debugLog("no binding matched");
  }
}

// Re-exports kept available for context-menu label utilities living
// alongside the dispatcher.
export { acceleratorToLabel, chordToLabel };
