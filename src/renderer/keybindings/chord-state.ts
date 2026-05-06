/**
 * Pure state machine for two-step keyboard chords (`⌘K …`).
 *
 * The dispatcher consults this module to know whether a "first half"
 * chord is currently armed, when it expires, and to enter / clear the
 * armed state. The chord-secondary matching itself lives in
 * {@link ./resolver}; the dispatcher orchestrates both.
 *
 * Design choices:
 *   - State lives in module scope. There's exactly one global keyboard
 *     dispatcher per renderer process and the state is implicitly
 *     scoped to it.
 *   - Time is injected. Tests use {@link setClock} to drive expiry
 *     deterministically; production stays on `Date.now()`.
 *   - Modifier-only keydown events (`Meta` / `Control` / `Shift` /
 *     `Alt` alone) do NOT clear the pending state. Holding /
 *     releasing ⌘ between leader and secondary is normal user
 *     behaviour and would otherwise tear down the chord.
 */

import { CHORD_DEFAULT_TIMEOUT_MS } from "../../shared/timing-constants";

interface PendingChord {
  /** The leader's accelerator string (used to filter chord secondaries). */
  leaderId: string;
  /** Wall-clock deadline; once `now() > expiresAt` the pending state is stale. */
  expiresAt: number;
}

let pending: PendingChord | null = null;

let clock: () => number = () => Date.now();

const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt", "OS", "Hyper", "Super"]);

/** True for keydown events that fire when only a modifier key is pressed. */
export function isModifierKeyOnly(e: KeyboardEvent): boolean {
  return MODIFIER_KEYS.has(e.key);
}

export function getPendingLeader(): string | null {
  return pending?.leaderId ?? null;
}

export function isPending(): boolean {
  return pending !== null;
}

/** Arm the chord with a fresh timeout. Replaces any prior pending. */
export function enterPending(leaderId: string, timeoutMs: number = CHORD_DEFAULT_TIMEOUT_MS): void {
  pending = { leaderId, expiresAt: clock() + timeoutMs };
}

/** Forget any armed chord. Safe to call when nothing is pending. */
export function clearPending(): void {
  pending = null;
}

/**
 * If the pending chord has expired (`now > expiresAt`), clear it and
 * report so. Returns true when an active state was just discarded.
 * Called at the top of the dispatcher so a stale chord can't mis-route
 * a fresh keystroke.
 */
export function purgeExpired(): boolean {
  if (!pending) return false;
  if (clock() <= pending.expiresAt) return false;
  pending = null;
  return true;
}

/** Test-only: inject a deterministic clock. */
export function __setClockForTests(fn: () => number): void {
  clock = fn;
}

/** Test-only: reset state and clock. */
export function __resetForTests(): void {
  pending = null;
  clock = () => Date.now();
}
