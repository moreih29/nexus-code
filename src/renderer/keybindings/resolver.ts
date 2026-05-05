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
import type { CommandId } from "../../shared/commands";

interface CompiledPrimary {
  decl: KeybindingDecl;
  parsed: ParsedKeystroke;
}

interface CompiledChord {
  decl: KeybindingDecl;
  leader: ParsedKeystroke;
  secondary: ParsedKeystroke;
  /** The leader's accelerator string, used as a stable id when filtering
   *  chord secondaries that share the same first half. */
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

/**
 * Result of resolving a single keydown.
 *
 * `respectGuardEditable` lets the dispatcher decide whether to honor
 * the legacy "no shortcut while typing" rule for that match. Phase 3
 * will replace it with a `when` context expression.
 */
export type Resolution =
  | { kind: "single"; command: CommandId; respectGuardEditable: boolean }
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
      if (matchesEvent(c.secondary, e)) {
        return { kind: "chord-completed", command: c.decl.command };
      }
    }
    return { kind: "chord-mismatch" };
  }

  for (const p of PRIMARIES) {
    if (matchesEvent(p.parsed, e)) {
      return {
        kind: "single",
        command: p.decl.command,
        respectGuardEditable: p.decl.guardEditable !== false,
      };
    }
  }

  for (const c of CHORDS) {
    if (matchesEvent(c.leader, e)) {
      return { kind: "chord-leader", leaderId: c.leaderId };
    }
  }

  return { kind: "none" };
}
