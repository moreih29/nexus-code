import type { AcceleratorString } from "./index";
import { normalizeKeystroke } from "./keybinding-parse";
import { findReservedKey, type ReservedKey } from "./reserved-keys";

export type KeybindingConflictKind = "blocking" | "overlap" | "shadow" | "system";

export interface KeybindingConflict {
  kind: KeybindingConflictKind;
  command?: string;
  reserved?: ReservedKey;
}

export interface ConflictBinding {
  command: string;
  primary?: AcceleratorString;
  chord?: readonly [AcceleratorString, AcceleratorString];
  when?: string;
}

export interface ConflictQuery {
  command: string;
  primary?: AcceleratorString;
  chord?: readonly [AcceleratorString, AcceleratorString];
  when?: string;
  bindings: readonly ConflictBinding[];
  isMac: boolean;
  isWindows?: boolean;
}

export function detectConflicts(q: ConflictQuery): KeybindingConflict[] {
  const conflicts: KeybindingConflict[] = [];
  const isMac = q.isMac;

  const proposedPrimary = q.primary !== undefined ? normalizeKeystroke(q.primary, isMac) : null;
  const proposedLeader = q.chord !== undefined ? normalizeKeystroke(q.chord[0], isMac) : null;
  const proposedSecondary = q.chord !== undefined ? normalizeKeystroke(q.chord[1], isMac) : null;

  for (const b of q.bindings) {
    if (b.command === q.command) continue;

    if (!firesOnPlatform(b.when, isMac)) continue;

    if (scopesProvablyDisjoint(q.when, b.when)) continue;

    const bPrimary = b.primary !== undefined ? normalizeKeystroke(b.primary, isMac) : null;
    const bLeader = b.chord !== undefined ? normalizeKeystroke(b.chord[0], isMac) : null;
    const bSecondary = b.chord !== undefined ? normalizeKeystroke(b.chord[1], isMac) : null;

    if (proposedPrimary !== null && bPrimary !== null && proposedPrimary === bPrimary) {
      conflicts.push({ kind: scopeGrade(q.when, b.when), command: b.command });
    }

    if (proposedPrimary !== null && bLeader !== null && proposedPrimary === bLeader) {
      conflicts.push({ kind: "blocking", command: b.command });
    }

    if (proposedLeader !== null && bPrimary !== null && proposedLeader === bPrimary) {
      conflicts.push({ kind: "blocking", command: b.command });
    }

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

  for (const accel of [q.primary, q.chord?.[0]]) {
    if (accel === undefined) continue;
    const reserved = findReservedKey(accel, isMac, q.isWindows === true);
    if (reserved !== undefined) {
      conflicts.push({ kind: reserved.source === "system" ? "system" : "shadow", reserved });
    }
  }

  return conflicts;
}

function scopeGrade(a: string | undefined, b: string | undefined): KeybindingConflictKind {
  if (a === undefined || b === undefined) return "blocking";
  if (a === b) return "blocking";
  return "overlap";
}

function topLevelLiterals(when: string): { pos: Set<string>; neg: Set<string> } {
  const pos = new Set<string>();
  const neg = new Set<string>();
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

function firesOnPlatform(when: string | undefined, isMac: boolean): boolean {
  if (when === undefined) return true;
  const { pos, neg } = topLevelLiterals(when);
  return isMac ? !neg.has("isMac") && !pos.has("isWindows") : !pos.has("isMac");
}

function scopesProvablyDisjoint(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const la = topLevelLiterals(a);
  const lb = topLevelLiterals(b);
  for (const k of la.pos) if (lb.neg.has(k)) return true;
  for (const k of la.neg) if (lb.pos.has(k)) return true;
  return false;
}

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
