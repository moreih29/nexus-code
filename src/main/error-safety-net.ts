/**
 * Global error safety net for the main process.
 *
 * Installs process-level handlers for uncaught exceptions and unhandled promise
 * rejections so that unexpected failures are always logged via the shared facade
 * rather than silently dropped or crashing the process without a trace.
 *
 * Two-phase activation strategy
 * ─────────────────────────────
 * Phase 1 — "log-only" (current):
 *   We are still discovering unhandled rejections that were previously silent.
 *   Exiting immediately would kill the app during this warm-up period, so we
 *   log the error at `error` level and continue.  The goal is to identify all
 *   call-sites that need explicit error handling before we tighten the safety
 *   net.
 *
 * Phase 2 — "exit" (future):
 *   Once all known sources of unhandled rejections have been addressed, flip
 *   ERROR_SAFETY_NET_MODE to "exit".  The process will then log the fault and
 *   call `process.exit(1)` so that Electron's crash reporter and any process
 *   supervisor can detect and restart a clean instance rather than letting the
 *   app limp along in an undefined state.
 *
 * Switching between modes:
 *   Change the single constant below — one line, one place.  No other code
 *   needs to change.
 */

import { createLogger } from "../shared/log/main";

const log = createLogger("main");

// ---------------------------------------------------------------------------
// Mode switch — change "log-only" to "exit" when Phase 2 is ready.
// ---------------------------------------------------------------------------

type SafetyNetMode = "log-only" | "exit";

/**
 * Current operating mode of the global error safety net.
 *
 * "log-only" — record the fault; the process continues running.
 * "exit"      — record the fault then call process.exit(1).
 *
 * Flip to "exit" after all known unhandled-rejection sources have been fixed.
 */
const ERROR_SAFETY_NET_MODE: SafetyNetMode = "log-only";

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Handles an error value that may be an Error instance or an arbitrary thrown
 * value and returns a plain string suitable for logging.
 */
function describeError(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  return String(value);
}

/**
 * Responds to the detected fault according to the current mode:
 * - "log-only": the error has already been logged; do nothing further.
 * - "exit": terminate the process so a supervisor can start a clean instance.
 */
function handleFault(): void {
  if (ERROR_SAFETY_NET_MODE === "exit") {
    process.exit(1);
  }
  // "log-only": return so the process continues — intentional for Phase 1.
}

/**
 * Handler for `process.uncaughtException`.
 *
 * An uncaught exception means a synchronous throw escaped every try/catch in
 * the call stack.  The main process is in an unknown, potentially inconsistent
 * state after this event; continuing is unsafe in general.  We log the full
 * stack trace and then defer to `handleFault()` which will exit in Phase 2.
 */
export function onUncaughtException(error: Error): void {
  log.error(`Uncaught exception: ${describeError(error)}`);
  handleFault();
}

/**
 * Handler for `process.unhandledRejection`.
 *
 * Fires when a Promise is rejected and no `.catch()` / `try/await` handles the
 * rejection within the same microtask turn.  This often signals a forgotten
 * `await` or a missing error path.  We log at `error` level so these surface
 * in the file sink during Phase 1 warm-up.
 */
export function onUnhandledRejection(reason: unknown): void {
  log.error(`Unhandled promise rejection: ${describeError(reason)}`);
  handleFault();
}

// ---------------------------------------------------------------------------
// Public setup entry point
// ---------------------------------------------------------------------------

/**
 * Installs the global error safety net on the current process.
 *
 * Call once, immediately after `initMainLogger()`, so that every subsequent
 * initialisation step is covered.
 */
export function installErrorSafetyNet(): void {
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);
}
