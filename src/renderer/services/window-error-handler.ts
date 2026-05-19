/**
 * Unified window-level error safety net for the renderer process.
 *
 * Installs two global listeners:
 *   - window 'error'             — synchronous JS errors that escape all
 *                                  call-stack handlers (uncaught exceptions).
 *   - window 'unhandledrejection' — promise rejections that were never caught.
 *
 * Cancellation policy:
 *   Both listeners apply `isPureCanceled` before logging. Promises rejected
 *   with a "Canceled" sentinel are normal IPC abort signals — they must remain
 *   silent (no log, no surface) and must call `preventDefault()` so the runtime
 *   does not treat them as errors.
 *
 * Scope boundary:
 *   These handlers catch errors that originate outside React's render cycle
 *   (event handlers, async continuations, third-party library callbacks).
 *   React render/lifecycle errors are caught by ErrorBoundary components
 *   (app.tsx) and do NOT reach window.onerror. Both layers together give
 *   complete renderer-level coverage.
 *
 * Returns a cleanup function that removes both listeners — useful in tests.
 */

import { createLogger } from "../../shared/log/renderer";

const log = createLogger("renderer");

// ---------------------------------------------------------------------------
// Cancellation predicate
//
// Migrated verbatim from the former rejection-sink.ts. A rejection/error is
// a pure "Canceled" signal when its reason object carries name === "Canceled"
// OR message === "Canceled". This covers:
//   • AbortError from AbortController (IPC relay sets name="Canceled")
//   • CancellationToken errors that set message="Canceled"
// ---------------------------------------------------------------------------

export function isPureCanceled(reason: unknown): boolean {
  if (typeof reason !== "object" || reason === null) {
    return false;
  }

  const candidate = reason as { message?: unknown; name?: unknown };
  return candidate.name === "Canceled" || candidate.message === "Canceled";
}

// ---------------------------------------------------------------------------
// Handler implementations
// ---------------------------------------------------------------------------

function onError(event: ErrorEvent): void {
  // Synchronous uncaught errors. Check whether the underlying error value is a
  // cancellation before surfacing.
  if (isPureCanceled(event.error)) {
    event.preventDefault();
    return;
  }

  log.error("Uncaught renderer error", {});

  // Do NOT call preventDefault — let the Electron default handler see the
  // error so that DevTools console and crash reporting still work.
}

function onUnhandledRejection(event: PromiseRejectionEvent): void {
  if (isPureCanceled(event.reason)) {
    // Silent: normal cancellation flow — suppress the unhandled-rejection
    // warning so it never surfaces as a visible error.
    event.preventDefault();
    return;
  }

  log.error("Unhandled promise rejection in renderer", {});

  // Do NOT call preventDefault — let the runtime surface the rejection so
  // DevTools console and crash reporting remain informed.
}

// ---------------------------------------------------------------------------
// Public installer
// ---------------------------------------------------------------------------

/**
 * Installs the unified window 'error' and 'unhandledrejection' handlers.
 *
 * Call once during renderer bootstrap (index.tsx), before mounting React.
 * Returns a teardown function for test isolation.
 */
export function installWindowErrorHandlers(): () => void {
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}
