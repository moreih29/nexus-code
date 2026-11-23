import { CHORD_DEFAULT_TIMEOUT_MS } from "../../shared/util/timing-constants";

interface PendingChord {
  leaderId: string;
  expiresAt: number;
}

let pending: PendingChord | null = null;

let clock: () => number = () => Date.now();

const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt", "OS", "Hyper", "Super"]);

export function isModifierKeyOnly(e: KeyboardEvent): boolean {
  return MODIFIER_KEYS.has(e.key);
}

export function getPendingLeader(): string | null {
  return pending?.leaderId ?? null;
}

export function isPending(): boolean {
  return pending !== null;
}

export function enterPending(leaderId: string, timeoutMs: number = CHORD_DEFAULT_TIMEOUT_MS): void {
  pending = { leaderId, expiresAt: clock() + timeoutMs };
}

export function clearPending(): void {
  pending = null;
}

export function purgeExpired(): boolean {
  if (!pending) return false;
  if (clock() <= pending.expiresAt) return false;
  pending = null;
  return true;
}

export function chordClock(): number {
  return clock();
}

export function __setClockForTests(fn: () => number): void {
  clock = fn;
}

export function __resetForTests(): void {
  pending = null;
  clock = () => Date.now();
}
