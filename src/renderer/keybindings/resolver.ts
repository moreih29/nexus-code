import type { CommandId } from "../../shared/keybindings/commands";
import { KEYBINDINGS, type KeybindingDecl } from "../../shared/keybindings/index";
import {
  matchesEvent,
  type ParsedKeystroke,
  parseAccelerator,
} from "../../shared/keybindings/keybinding-parse";
import { evaluateWhen, parseWhen, type WhenExpr } from "../../shared/keybindings/keybinding-when";
import { isMac } from "../utils/platform";
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
  leaderId: string;
  when: WhenExpr | null;
}

let PRIMARIES: CompiledPrimary[] = [];
let CHORDS: CompiledChord[] = [];
let ACTIVE_BINDINGS: readonly KeybindingDecl[] = KEYBINDINGS;

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
    } catch {}
  }
  PRIMARIES = primaries;
  CHORDS = chords;
  ACTIVE_BINDINGS = bindings;
}

compile(KEYBINDINGS);

export function setActiveBindings(bindings: readonly KeybindingDecl[]): void {
  compile(bindings);
}

export function getActiveBindings(): readonly KeybindingDecl[] {
  return ACTIVE_BINDINGS;
}

export function __resetActiveBindingsForTests(): void {
  compile(KEYBINDINGS);
}

export type Resolution =
  | { kind: "single"; command: CommandId }
  | { kind: "chord-leader"; leaderId: string }
  | { kind: "chord-completed"; command: CommandId }
  | { kind: "chord-mismatch" }
  | { kind: "none" };

export function resolveEvent(e: KeyboardEvent, pendingLeader: string | null): Resolution {
  const mac = isMac();
  if (pendingLeader !== null) {
    for (const c of CHORDS) {
      if (c.leaderId !== pendingLeader) continue;
      if (!whenMatches(c.when, e)) continue;
      const masked = maskLeaderModifiers(e, c.leader, c.secondary);
      if (matchesEvent(c.secondary, masked, mac)) {
        return { kind: "chord-completed", command: c.decl.command };
      }
    }
    return { kind: "chord-mismatch" };
  }

  for (const p of PRIMARIES) {
    if (!matchesEvent(p.parsed, e, mac)) continue;
    if (!whenMatches(p.when, e)) continue;
    return { kind: "single", command: p.decl.command };
  }

  for (const c of CHORDS) {
    if (!matchesEvent(c.leader, e, mac)) continue;
    if (!whenMatches(c.when, e)) continue;
    return { kind: "chord-leader", leaderId: c.leaderId };
  }

  return { kind: "none" };
}

function whenMatches(expr: WhenExpr | null, e: KeyboardEvent): boolean {
  if (expr === null) return true;
  return evaluateWhen(expr, (name) => evaluateContextKey(name, e));
}

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
    metaKey: stripCmd ? false : e.metaKey,
    ctrlKey: stripCmd || stripCtrl ? false : e.ctrlKey,
    shiftKey: stripShift ? false : e.shiftKey,
    altKey: stripAlt ? false : e.altKey,
  } as KeyboardEvent;
}
