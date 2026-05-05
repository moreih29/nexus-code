/**
 * Pure resolver: keystroke → resolution.
 *
 * Compiles `KEYBINDINGS` into match predicates once at module load,
 * then maps each keydown event (plus the current chord-pending leader)
 * to a tagged {@link Resolution}. The dispatcher consumes the
 * resolution to decide whether to fire a command, arm a chord, swallow
 * the keystroke, or let it bubble.
 *
 * Splitting this away from the dispatcher means:
 *   - Match logic is testable without DOM, React, or event listener
 *     plumbing.
 *   - Adding `when` context evaluation in Phase 3 lands here, not in
 *     the dispatcher.
 */

import { matchesEvent, type ParsedKeystroke, parseAccelerator } from "../../shared/keybinding-parse";
import { type KeybindingDecl, KEYBINDINGS } from "../../shared/keybindings";
import { evaluateWhen, parseWhen, type WhenExpr } from "../../shared/keybinding-when";
import type { CommandId } from "../../shared/commands";
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

const PRIMARIES: CompiledPrimary[] = [];
const CHORDS: CompiledChord[] = [];

for (const decl of KEYBINDINGS) {
  const when = decl.when !== undefined ? parseWhen(decl.when) : null;
  if (decl.primary !== undefined) {
    PRIMARIES.push({ decl, parsed: parseAccelerator(decl.primary), when });
  }
  if (decl.chord !== undefined) {
    CHORDS.push({
      decl,
      leader: parseAccelerator(decl.chord[0]),
      secondary: parseAccelerator(decl.chord[1]),
      leaderId: decl.chord[0],
      when,
    });
  }
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
      if (matchesEvent(c.secondary, masked)) {
        return { kind: "chord-completed", command: c.decl.command };
      }
    }
    return { kind: "chord-mismatch" };
  }

  for (const p of PRIMARIES) {
    if (!matchesEvent(p.parsed, e)) continue;
    if (!whenMatches(p.when, e)) continue;
    return { kind: "single", command: p.decl.command };
  }

  for (const c of CHORDS) {
    if (!matchesEvent(c.leader, e)) continue;
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
  const stripShift = leader.shift && !secondary.shift;
  const stripAlt = leader.alt && !secondary.alt;
  if (!stripCmd && !stripShift && !stripAlt) return e;
  return {
    code: e.code,
    key: e.key,
    metaKey: stripCmd ? false : e.metaKey,
    ctrlKey: stripCmd ? false : e.ctrlKey,
    shiftKey: stripShift ? false : e.shiftKey,
    altKey: stripAlt ? false : e.altKey,
  } as KeyboardEvent;
}
