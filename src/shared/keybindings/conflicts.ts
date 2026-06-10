/**
 * Keybinding conflict engine.
 *
 * Evaluates a PROPOSED binding (what the user just recorded in the
 * settings UI) against (a) the current effective binding table and
 * (b) the reserved/built-in key catalog. Pure and synchronous — the
 * recorder calls it on every keystroke for instant feedback.
 *
 * Conflict grades (UI policy in parentheses):
 *   - "blocking" — collides with another app command in an overlapping
 *     `when` scope, or makes a chord unreachable. (Refuse to save until
 *     the user unbinds the other side.)
 *   - "overlap"  — same keystroke as another app command but both sides
 *     carry different non-empty `when` scopes. Scope disjointness is
 *     undecidable in general, so this is a warning, not a block.
 *   - "shadow"   — collides with a built-in key (Monaco / terminal /
 *     Electron role). Saving is allowed but the user is told exactly
 *     what stops working. This is the ⌘/-bug class made visible.
 *   - "system"   — OS-reserved (⌘Q, ⌘H, …). The recorder refuses the
 *     keystroke outright.
 *
 * Scope-overlap rule: two bindings on the same keystroke conflict as
 * "blocking" when either side is unscoped (fires everywhere, including
 * inside the other's scope) or both scopes are textually identical.
 * Textual comparison is deliberate — a real implication solver over
 * the when-grammar buys little for a 40-command catalog.
 */

import type { AcceleratorString } from "./index";
import { normalizeKeystroke } from "./keybinding-parse";
import { findReservedKey, type ReservedKey } from "./reserved-keys";

export type KeybindingConflictKind = "blocking" | "overlap" | "shadow" | "system";

export interface KeybindingConflict {
  kind: KeybindingConflictKind;
  /**
   * The colliding command id (blocking / overlap). A plain string so the
   * engine serves both app dispatcher commands (CommandId) and editor
   * (Monaco) command ids — the recorder maps it back to a label.
   */
  command?: string;
  /** The colliding reserved key (shadow / system). */
  reserved?: ReservedKey;
}

/**
 * Minimal shape the engine reads from each existing binding. Both the
 * app `KeybindingDecl` and synthetic editor-command bindings satisfy it.
 */
export interface ConflictBinding {
  command: string;
  primary?: AcceleratorString;
  chord?: readonly [AcceleratorString, AcceleratorString];
  when?: string;
}

export interface ConflictQuery {
  /** Command being (re)bound — its own declarations are skipped. */
  command: string;
  primary?: AcceleratorString;
  chord?: readonly [AcceleratorString, AcceleratorString];
  /** `when` scope the proposed binding will carry (inherited from defaults). */
  when?: string;
  /** EFFECTIVE bindings (defaults + overrides already applied). */
  bindings: readonly ConflictBinding[];
  isMac: boolean;
}

export function detectConflicts(q: ConflictQuery): KeybindingConflict[] {
  const conflicts: KeybindingConflict[] = [];
  const isMac = q.isMac;

  const proposedPrimary = q.primary !== undefined ? normalizeKeystroke(q.primary, isMac) : null;
  const proposedLeader = q.chord !== undefined ? normalizeKeystroke(q.chord[0], isMac) : null;
  const proposedSecondary = q.chord !== undefined ? normalizeKeystroke(q.chord[1], isMac) : null;

  for (const b of q.bindings) {
    if (b.command === q.command) continue;

    // Two bindings whose `when` scopes are provably mutually exclusive
    // (e.g. `browserTabActive` vs `!browserTabActive`) never fire on the
    // same event, so they are NOT a conflict at all — skip every check
    // for this pair. This kills the false-positive overlap the textual
    // scopeGrade would otherwise report for our browser-routed defaults
    // (⌘R, ⌘⇧R: files.refresh vs browser reload).
    if (scopesProvablyDisjoint(q.when, b.when)) continue;

    const bPrimary = b.primary !== undefined ? normalizeKeystroke(b.primary, isMac) : null;
    const bLeader = b.chord !== undefined ? normalizeKeystroke(b.chord[0], isMac) : null;
    const bSecondary = b.chord !== undefined ? normalizeKeystroke(b.chord[1], isMac) : null;

    // primary vs primary — the classic duplicate.
    if (proposedPrimary !== null && bPrimary !== null && proposedPrimary === bPrimary) {
      conflicts.push({ kind: scopeGrade(q.when, b.when), command: b.command });
    }

    // primary vs another command's chord LEADER: the resolver matches
    // singles before chord leaders, so the proposed primary would make
    // that chord unreachable. Always blocking — `when` can't save a
    // chord whose first half never arms.
    if (proposedPrimary !== null && bLeader !== null && proposedPrimary === bLeader) {
      conflicts.push({ kind: "blocking", command: b.command });
    }

    // chord LEADER vs another command's primary — mirror of the above:
    // the existing primary fires first and the proposed chord never arms.
    if (proposedLeader !== null && bPrimary !== null && proposedLeader === bPrimary) {
      conflicts.push({ kind: "blocking", command: b.command });
    }

    // chord vs chord — same leader AND same secondary.
    if (
      proposedLeader !== null &&
      bLeader !== null &&
      proposedLeader === bLeader &&
      proposedSecondary !== null &&
      bSecondary !== null &&
      proposedSecondary === bSecondary
    ) {
      conflicts.push({ kind: scopeGrade(q.when, b.when), command: b.command });
    }
  }

  // Reserved / built-in collisions. Checked for the primary and the
  // chord leader (a leader swallow is just as destructive); chord
  // secondaries only fire during a pending chord, which no built-in
  // can observe — skip them.
  for (const accel of [q.primary, q.chord?.[0]]) {
    if (accel === undefined) continue;
    const reserved = findReservedKey(accel, isMac);
    if (reserved !== undefined) {
      conflicts.push({ kind: reserved.source === "system" ? "system" : "shadow", reserved });
    }
  }

  return conflicts;
}

/**
 * Grade a same-keystroke collision by `when` scope:
 * either side unscoped or identical scopes → blocking; both scoped
 * differently → overlap (possibly disjoint — warn, don't block).
 */
function scopeGrade(a: string | undefined, b: string | undefined): KeybindingConflictKind {
  if (a === undefined || b === undefined) return "blocking";
  if (a === b) return "blocking";
  return "overlap";
}

/** Top-level AND'd simple literals of a `when` clause, split into the
 *  context keys it requires true vs false. Parenthesised groups and `||`
 *  sub-expressions are opaque — only bare `key` / `!key` conjuncts count.
 *  `"!browserTabActive && (!terminalFocus || isMac)"` → pos:{}, neg:{browserTabActive}. */
function topLevelLiterals(when: string): { pos: Set<string>; neg: Set<string> } {
  const pos = new Set<string>();
  const neg = new Set<string>();
  // Split on `&&` at paren depth 0.
  let depth = 0;
  let start = 0;
  const parts: string[] = [];
  for (let i = 0; i < when.length; i++) {
    const ch = when[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && ch === "&" && when[i + 1] === "&") {
      parts.push(when.slice(start, i));
      i++;
      start = i + 1;
    }
  }
  parts.push(when.slice(start));

  for (const raw of parts) {
    const tok = raw.trim();
    const neg1 = /^!\s*([A-Za-z][A-Za-z0-9]*)$/.exec(tok);
    if (neg1 !== null) {
      neg.add(neg1[1] as string);
      continue;
    }
    const pos1 = /^([A-Za-z][A-Za-z0-9]*)$/.exec(tok);
    if (pos1 !== null) pos.add(pos1[1] as string);
  }
  return { pos, neg };
}

/**
 * True when two `when` scopes can be PROVEN mutually exclusive: one
 * requires a context key true while the other requires the same key
 * false (as top-level AND conjuncts). Conservative — returns false
 * whenever it cannot prove disjointness, so it never hides a real
 * conflict; it only suppresses the obvious `X` vs `!X` false positives
 * (our browser-tab routing). A full boolean solver is unwarranted for a
 * catalog this size.
 */
function scopesProvablyDisjoint(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const la = topLevelLiterals(a);
  const lb = topLevelLiterals(b);
  for (const k of la.pos) if (lb.neg.has(k)) return true;
  for (const k of la.neg) if (lb.pos.has(k)) return true;
  return false;
}

/**
 * Compute command-vs-command conflicts across an ENTIRE effective binding
 * table, keyed by command id. Unlike {@link detectConflicts} (which
 * evaluates one proposed binding at record time), this is the persistent
 * view the settings table renders on every row — so a conflict created
 * INDIRECTLY (resetting a command back to a default that now collides, or
 * the *other* side being rebound onto your key) surfaces on both rows
 * without anyone re-opening the recorder.
 *
 * Scope: command-vs-command only (blocking / overlap). Reserved/built-in
 * SHADOW collisions are deliberately excluded here — an unchanged editor
 * command sits on its own Monaco default by definition, so a shadow pass
 * would flag every default against itself. Shadow/system warnings remain
 * a record-time concern (the live recorder still reports them).
 *
 * Both sides of a collision receive an entry (the per-command run is
 * symmetric), so every participating row can render a badge.
 */
export function detectTableConflicts(
  bindings: readonly ConflictBinding[],
  isMac: boolean,
): Map<string, KeybindingConflict[]> {
  const out = new Map<string, KeybindingConflict[]>();
  const seen = new Set<string>();

  for (const b of bindings) {
    if (seen.has(b.command)) continue;
    seen.add(b.command);

    const prim = bindings.find((x) => x.command === b.command && x.primary !== undefined);
    const ch = bindings.find((x) => x.command === b.command && x.chord !== undefined);
    if (prim === undefined && ch === undefined) continue;

    const when = prim?.when ?? ch?.when;
    const conflicts = detectConflicts({
      command: b.command,
      ...(prim?.primary !== undefined ? { primary: prim.primary } : {}),
      ...(ch?.chord !== undefined ? { chord: ch.chord } : {}),
      ...(when !== undefined ? { when } : {}),
      bindings,
      isMac,
    }).filter((c) => c.kind === "blocking" || c.kind === "overlap");

    if (conflicts.length > 0) out.set(b.command, conflicts);
  }

  return out;
}
