/**
 * Pure resolver: keystroke → resolution.
 *
 * Compiles a binding table into match predicates — `KEYBINDINGS` at
 * module load, then any EFFECTIVE table (defaults + user overrides)
 * pushed through {@link setActiveBindings} when the keybindings store
 * hydrates or the user edits a binding. Each keydown event (plus the
 * current chord-pending leader) maps to a tagged {@link Resolution}.
 * The dispatcher consumes the resolution to decide whether to fire a
 * command, arm a chord, swallow the keystroke, or let it bubble.
 *
 * Splitting this away from the dispatcher means:
 *   - Match logic is testable without DOM, React, or event listener
 *     plumbing.
 *   - `when` context evaluation lives here, not in the dispatcher: the
 *     resolver decides whether a binding applies, the dispatcher only
 *     decides what to do with the resolution.
 */

import type { CommandId } from "../../shared/keybindings/commands";
import { KEYBINDINGS, type KeybindingDecl } from "../../shared/keybindings/index";
import {
  matchesEvent,
  type ParsedKeystroke,
  parseAccelerator,
} from "../../shared/keybindings/keybinding-parse";
import { evaluateWhen, parseWhen, type WhenExpr } from "../../shared/keybindings/keybinding-when";
import { evaluateContextKey } from "./context-keys";

interface CompiledPrimary {
  decl: KeybindingDecl;
  parsed: ParsedKeystroke;
  when: WhenExpr | null;
}

interface CompiledChord {
  decl: KeybindingDecl;
  leader: ParsedKeystroke;
  secondary: ParsedKeystroke;
  /** The leader's accelerator string, used as a stable id when filtering
   *  chord secondaries that share the same first half. */
  leaderId: string;
  when: WhenExpr | null;
}

/**
 * Cached platform flag. Renderer module load happens after the DOM is
 * available, so `navigator` is safe to read here. We only need this
 * once per session — the user does not switch OS mid-run.
 *
 * Used by `matchesEvent` to disambiguate the `CmdOrCtrl` shorthand:
 * on Mac it means ⌘ exclusively (so xterm keeps its ⌃-letter shortcuts);
 * on Win/Linux it means Ctrl exclusively.
 */
const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPod|iPad/i.test(navigator.platform || "");

let PRIMARIES: CompiledPrimary[] = [];
let CHORDS: CompiledChord[] = [];
let ACTIVE_BINDINGS: readonly KeybindingDecl[] = KEYBINDINGS;

/**
 * Compile `bindings` into the active match tables. A declaration that
 * fails to parse is skipped (with the others kept) rather than taking
 * the whole table down — user overrides are validated at the schema
 * boundary, but a defense here means one bad entry can never cost the
 * user every shortcut at once.
 */
function compile(bindings: readonly KeybindingDecl[]): void {
  const primaries: CompiledPrimary[] = [];
  const chords: CompiledChord[] = [];
  for (const decl of bindings) {
    try {
      const when = decl.when !== undefined ? parseWhen(decl.when) : null;
      if (decl.primary !== undefined) {
        primaries.push({ decl, parsed: parseAccelerator(decl.primary), when });
      }
      if (decl.chord !== undefined) {
        chords.push({
          decl,
          leader: parseAccelerator(decl.chord[0]),
          secondary: parseAccelerator(decl.chord[1]),
          leaderId: decl.chord[0],
          when,
        });
      }
    } catch {
      // skip unparseable declaration; keep the rest
    }
  }
  PRIMARIES = primaries;
  CHORDS = chords;
  ACTIVE_BINDINGS = bindings;
}

compile(KEYBINDINGS);

/**
 * Swap the active binding table (defaults + user overrides, already
 * merged by `applyKeybindingOverrides`). Recompilation is O(table
 * size) string parsing — trivially cheap, safe to call on every store
 * update.
 */
export function setActiveBindings(bindings: readonly KeybindingDecl[]): void {
  compile(bindings);
}

/**
 * The binding table currently driving dispatch. Label renderers
 * (context menus, the settings panel) read THIS — not the static
 * `KEYBINDINGS` — so user overrides show up everywhere a shortcut is
 * displayed.
 */
export function getActiveBindings(): readonly KeybindingDecl[] {
  return ACTIVE_BINDINGS;
}

/** Test-only — restore the default table between tests. */
export function __resetActiveBindingsForTests(): void {
  compile(KEYBINDINGS);
}

/**
 * Result of resolving a single keydown. The dispatcher decides what to
 * do with each variant; the resolver itself never touches the DOM.
 */
export type Resolution =
  | { kind: "single"; command: CommandId }
  | { kind: "chord-leader"; leaderId: string }
  | { kind: "chord-completed"; command: CommandId }
  | { kind: "chord-mismatch" }
  | { kind: "none" };

/**
 * Resolve a keydown event.
 *
 *   - When `pendingLeader` is set, the event is interpreted as a chord
 *     secondary first: a match yields `chord-completed`; no match
 *     yields `chord-mismatch` (the dispatcher then swallows + clears
 *     state, matching VSCode's behaviour).
 *   - Otherwise we try a single-keystroke binding, then a chord
 *     leader.
 *
 * Modifier-only and Escape keystrokes are NOT special-cased here —
 * the dispatcher handles those before consulting the resolver.
 */
export function resolveEvent(e: KeyboardEvent, pendingLeader: string | null): Resolution {
  if (pendingLeader !== null) {
    for (const c of CHORDS) {
      if (c.leaderId !== pendingLeader) continue;
      if (!whenMatches(c.when, e)) continue;
      // Mask leader-only modifiers when matching the secondary so
      // users who keep ⌘ held through a `⌘K U` chord aren't punished
      // (`KeyU` with metaKey set would otherwise fail an exact match
      // against a secondary declared as bare `U`). VSCode's exact
      // matcher requires releasing ⌘ between halves; this is a
      // strict-superset relaxation that still lets every VSCode-style
      // press complete.
      const masked = maskLeaderModifiers(e, c.leader, c.secondary);
      if (matchesEvent(c.secondary, masked, IS_MAC)) {
        return { kind: "chord-completed", command: c.decl.command };
      }
    }
    return { kind: "chord-mismatch" };
  }

  for (const p of PRIMARIES) {
    if (!matchesEvent(p.parsed, e, IS_MAC)) continue;
    if (!whenMatches(p.when, e)) continue;
    return { kind: "single", command: p.decl.command };
  }

  for (const c of CHORDS) {
    if (!matchesEvent(c.leader, e, IS_MAC)) continue;
    if (!whenMatches(c.when, e)) continue;
    return { kind: "chord-leader", leaderId: c.leaderId };
  }

  return { kind: "none" };
}

function whenMatches(expr: WhenExpr | null, e: KeyboardEvent): boolean {
  if (expr === null) return true;
  return evaluateWhen(expr, (name) => evaluateContextKey(name, e));
}

/**
 * Return an event-shaped object with leader-only modifiers cleared.
 * "Leader-only" means a modifier the leader requires but the secondary
 * does not — those modifiers might still be physically held as the
 * user transitions from leader to secondary, and we don't want that
 * to make the secondary miss its match.
 *
 * Modifiers required by both leader and secondary (or required only
 * by the secondary) pass through unchanged so an explicit
 * `CmdOrCtrl+W` secondary still requires the user to be holding ⌘.
 */
function maskLeaderModifiers(
  e: KeyboardEvent,
  leader: ParsedKeystroke,
  secondary: ParsedKeystroke,
): KeyboardEvent {
  const stripCmd = leader.cmd && !secondary.cmd;
  const stripCtrl = leader.ctrl && !secondary.ctrl;
  const stripShift = leader.shift && !secondary.shift;
  const stripAlt = leader.alt && !secondary.alt;
  if (!stripCmd && !stripCtrl && !stripShift && !stripAlt) return e;
  return {
    code: e.code,
    key: e.key,
    // `stripCmd` (the CmdOrCtrl shorthand path) zeroes both physical
    // modifiers because either could have been the one matched at the
    // leader; `stripCtrl` only clears `ctrlKey` because a literal Ctrl
    // leader specifically held Control, not Meta.
    metaKey: stripCmd ? false : e.metaKey,
    ctrlKey: stripCmd || stripCtrl ? false : e.ctrlKey,
    shiftKey: stripShift ? false : e.shiftKey,
    altKey: stripAlt ? false : e.altKey,
  } as KeyboardEvent;
}
