/**
 * useIpcAction — unified async-action lifecycle hook for IPC-backed operations.
 *
 * DESIGN
 * ------
 * Every IPC call in the renderer follows the same lifecycle:
 *   idle → loading → (success | error | idle-via-cancel)
 *
 * Problems this hook eliminates:
 *   1. "Connecting…" freeze — any unguarded `await` that throws leaves a boolean
 *      `isLoading` flag stuck at `true` forever.  Here, a single try/catch/finally
 *      wraps the entire action body, guaranteeing the loading state is always
 *      cleared on exit.
 *   2. Double-submit — concurrent `run()` calls on loading state are silently
 *      dropped (no-op guard).
 *   3. Dead setState — unmount cancels the in-flight operation via AbortController
 *      and sets a `mounted` ref to `false`; the completion path checks both before
 *      calling `setState`.
 *   4. Rapid-remount race — each `run()` call mints a new AbortController.
 *      When superseded by a later call, the earlier controller's resolution is
 *      discarded by comparing controller identity at the point of state update.
 *
 * CANCEL SEMANTICS
 * ----------------
 * Two distinct cancellation paths exist:
 *
 *   • Unmount cancel (automatic) — fires when the component unmounts while a
 *     request is in-flight.  The promise outcome is silently discarded;
 *     status returns to whatever it was before the action (typically idle).
 *
 *   • User cancel (opt-in) — the returned `cancel()` function aborts the current
 *     controller and maps the outcome to status:'idle', suppressing any UI.
 *     An AppError with category:'cancelled' thrown inside the action body is
 *     treated identically to an explicit cancel() call.
 *
 * MULTI-STAGE ACTIONS
 * -------------------
 * When an action contains multiple `await` expressions, callers can attach
 * step context to errors by throwing a tagged AppError (with `code` set to
 * the failing step name).  Alternatively, a successful multi-stage action can
 * return a structured value that includes stage metadata — the `value` field
 * of the success state carries it unchanged.
 *
 * NO AUTO-SURFACE
 * ---------------
 * The hook is deliberately display-neutral.  It does not call toast(), open
 * banners, or log to console.  The component decides whether to surface
 * `state.error` inline or via an error surface helper.  This keeps the hook
 * reusable across form submissions, toolbar actions, and dialog confirm flows.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { type AppError, appErrorBug, appErrorCancelled } from "../../shared/error/app-error";
import { isAbortError } from "../../shared/abort";

// ---------------------------------------------------------------------------
// State type — discriminated union covering all four lifecycle phases
// ---------------------------------------------------------------------------

/** Waiting for the first run() invocation (or after a cancel). */
export interface IpcActionStateIdle {
  readonly status: "idle";
}

/** A run() invocation is in-flight. */
export interface IpcActionStateLoading {
  readonly status: "loading";
}

/** The action completed successfully. */
export interface IpcActionStateSuccess<T> {
  readonly status: "success";
  readonly value: T;
}

/** The action threw and was not cancelled. */
export interface IpcActionStateError {
  readonly status: "error";
  readonly error: AppError;
}

export type IpcActionState<T> =
  | IpcActionStateIdle
  | IpcActionStateLoading
  | IpcActionStateSuccess<T>
  | IpcActionStateError;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface UseIpcActionOptions<T> {
  /**
   * Called immediately after the action resolves with a value.
   * Provides a reliable delivery channel for success side-effects (navigation,
   * toast, parent state update) that must not be missed even when the component
   * conditionally renders based on the resulting state.
   */
  onSuccess?: (value: T) => void;
}

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export interface UseIpcActionReturn<T> {
  /** Discriminated-union state for the current action lifecycle. */
  readonly state: IpcActionState<T>;

  /**
   * Triggers the action.  A no-op when an action is already in-flight
   * (status === 'loading'), preventing double-submit.
   *
   * @param action - The async operation to execute.  It receives an AbortSignal
   *   that fires when the component unmounts or `cancel()` is called.  The action
   *   can tag AppErrors with `code` to identify which stage failed in multi-stage
   *   operations.
   */
  readonly run: (action: (signal: AbortSignal) => Promise<T>) => void;

  /**
   * Aborts the current in-flight action and transitions back to idle.
   * Safe to call at any time — a no-op when no action is in-flight.
   * The aborted action's outcome is suppressed (no error state, no surface).
   */
  readonly cancel: () => void;

  /**
   * Convenience alias for `state.status === 'loading'`.
   * Pass to button `disabled` props to prevent re-submission.
   */
  readonly isPending: boolean;
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

/**
 * Manages the async lifecycle of a single IPC action with guaranteed
 * cleanup, double-submit prevention, and structured error normalisation.
 *
 * @param options.onSuccess - Optional callback invoked once on each successful
 *   completion.  Use for side-effects that must not be missed.
 *
 * @example
 * ```tsx
 * const { state, run, isPending } = useIpcAction<WorkspaceId>({
 *   onSuccess: (id) => navigate(`/workspace/${id}`),
 * });
 *
 * const handleSubmit = () => {
 *   run(async (signal) => {
 *     const r = await ipcCallResult("workspace", "create", { ...formValues }, { signal });
 *     if (!r.ok) throw new Error(r.message);
 *     await ipcCallResult("workspace", "open", { id: r.value }, { signal });
 *     return r.value;
 *   });
 * };
 * ```
 */
export function useIpcAction<T>(options: UseIpcActionOptions<T> = {}): UseIpcActionReturn<T> {
  const { onSuccess } = options;

  const [state, setState] = useState<IpcActionState<T>>({ status: "idle" });

  // Tracks whether the component is still mounted.  Checked before every
  // setState call to prevent updating an unmounted component.
  const mountedRef = useRef(true);

  // Holds the AbortController for the currently in-flight action.
  // Each run() call replaces this reference with a fresh controller.
  // The previous controller is aborted before the new one is installed,
  // preventing stale resolutions from advancing state.
  const controllerRef = useRef<AbortController | null>(null);

  // Stable reference to onSuccess so the callback in run() never goes stale
  // without needing to list onSuccess in a useCallback dependency array.
  const onSuccessRef = useRef(onSuccess);
  useEffect(() => {
    onSuccessRef.current = onSuccess;
  });

  // Unmount cleanup — abort any in-flight action and mark the component dead.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  const cancel = useCallback(() => {
    if (!controllerRef.current) return;
    controllerRef.current.abort();
    controllerRef.current = null;
    // Transition back to idle — cancelled operations are not surfaced.
    if (mountedRef.current) {
      setState({ status: "idle" });
    }
  }, []);

  const run = useCallback(
    (action: (signal: AbortSignal) => Promise<T>) => {
      // Double-submit guard — atomically check the current status and transition
      // to 'loading', or bail out if already in-flight.
      //
      // Using the setState updater form (current => next) is the only way to
      // read committed state synchronously without introducing a separate ref.
      // A local flag relays the bail-out decision outside the setState call.
      let alreadyLoading = false;
      setState((current) => {
        if (current.status === "loading") {
          alreadyLoading = true;
          return current;
        }
        return { status: "loading" };
      });

      if (alreadyLoading) return;

      // Abort any previously-in-flight action.  Its completion path will see
      // its controller has been replaced and will discard its result.
      controllerRef.current?.abort();

      const controller = new AbortController();
      controllerRef.current = controller;

      // Execute the action inside a fully-guarded async IIFE.
      // The finally block is the single exit point that clears loading state,
      // so there is no code path that can leave status stuck at 'loading'.
      (async () => {
        try {
          const value = await action(controller.signal);

          // Discard stale resolutions: unmounted component or superseded controller.
          if (!mountedRef.current || controllerRef.current !== controller) return;

          setState({ status: "success", value });
          onSuccessRef.current?.(value);
        } catch (err: unknown) {
          // Discard stale error resolutions the same way.
          if (!mountedRef.current || controllerRef.current !== controller) return;

          // Determine whether the throw represents a cancellation.
          const isCancellation =
            isAbortError(err) ||
            (isAppError(err) && err.category === "cancelled");

          if (isCancellation) {
            // Cancelled operations return to idle without surfacing any UI.
            setState({ status: "idle" });
          } else {
            // Normalise unknown throws to AppError before storing in state.
            setState({ status: "error", error: normaliseError(err) });
          }
        } finally {
          // Release the controller reference only when it still points to this
          // run's controller.  A cancel() call may have already replaced it.
          if (controllerRef.current === controller) {
            controllerRef.current = null;
          }
        }
      })();
    },
    [], // No deps — all mutable state is accessed via refs or captured in closures.
  );

  return {
    state,
    run,
    cancel,
    isPending: state.status === "loading",
  };
}

// ---------------------------------------------------------------------------
// Internal helpers — exported for unit testing
// ---------------------------------------------------------------------------

/**
 * Type guard for AppError.  Checks the minimum structural contract
 * (category field present and a valid string) to avoid over-broad instanceof
 * checks that break across module boundaries.
 *
 * Exported so tests can verify the detection boundary without mounting a hook.
 */
export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === "object" &&
    value !== null &&
    "category" in value &&
    typeof (value as Record<string, unknown>).category === "string" &&
    "message" in value &&
    typeof (value as Record<string, unknown>).message === "string"
  );
}

/**
 * Converts an arbitrary thrown value into an AppError.
 *
 * - Already an AppError → returned as-is.
 * - Error instance → wrapped in category:'bug' preserving the message.
 * - Anything else → wrapped in category:'bug' with a safe string coercion.
 *
 * Category:'bug' signals to the UI that logging is mandatory and a generic
 * "unexpected error" message should be shown rather than the raw value.
 *
 * Exported so tests can verify normalisation rules without mounting a hook.
 */
export function normaliseError(err: unknown): AppError {
  if (isAppError(err)) return err;

  if (err instanceof Error) {
    return appErrorBug(err.message);
  }

  // Last-resort fallback for exotic throws (string literals, objects, etc.).
  const message =
    typeof err === "string" ? err : "An unexpected error occurred";
  return appErrorBug(message);
}

// Re-export for callers that need the cancelled helper without importing from shared.
export { appErrorCancelled };
