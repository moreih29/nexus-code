/**
 * Lightweight in-app toast.
 *
 * Imperative API: callers anywhere call `showToast({ kind, message })`
 * and a styled toast appears in the bottom-right stack.
 *
 * Two toast varieties:
 *   - Plain (no actions): auto-dismisses on a timer; user can also click × to dismiss.
 *     Uses `role="status"` — polite announcement, non-interrupting.
 *   - Action (has actions array): never auto-dismisses; stays until the user explicitly
 *     closes it. Uses `role="alert"` — assertive announcement. Action buttons are
 *     keyboard-reachable via normal tab order.
 *
 * Why custom (not Radix Toast): we already follow the imperative-API
 * + singleton-Root pattern from save-confirm-dialog. Toast doesn't need
 * focus management or aria-live trickery for the cases it serves
 * (filesystem operation feedback) — `role="status"` is sufficient for plain toasts.
 * Action toasts (bug category, retry-save) use `role="alert"` per WCAG guidance.
 *
 * Module is a singleton store + a Root component. The store keeps the
 * active toast list; the Root subscribes to it and re-renders on
 * change. No React context — toasts can be triggered from non-React
 * code paths (services, IPC error handlers).
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/cn";
import { createListenerBus } from "../../../shared/util/listener-bus";
import {
  UI_TOAST_ERROR_MS,
  UI_TOAST_INFO_MS,
  UI_TOAST_SWEEP_INTERVAL_MS,
} from "../../../shared/util/timing-constants";

export type ToastKind = "info" | "error";

/** A single action button attached to a toast. */
export interface ToastAction {
  /** Label shown on the button. */
  label: string;
  /** Callback invoked when the user clicks the action button. */
  onAction: () => void;
}

export interface ToastInput {
  kind: ToastKind;
  message: string;
  /**
   * Override auto-dismiss in ms. Defaults: see TOAST_INFO_MS / TOAST_ERROR_MS.
   * Ignored when `actions` is non-empty — action toasts never auto-dismiss.
   */
  durationMs?: number;
  /**
   * Optional action buttons. When provided the toast becomes an "action toast":
   *   - it uses `role="alert"` (assertive) instead of `role="status"` (polite)
   *   - it never auto-dismisses; the user must click × or an action button
   *   - action buttons are reachable via keyboard tab order
   */
  actions?: ToastAction[];
}

/**
 * Default auto-dismiss durations. Errors hold longer so the user can
 * still read the toast after switching focus to investigate.
 *
 * Re-exported under toast-local names so existing callers stay unchanged.
 * See `shared/util/timing-constants.ts` for the canonical definitions.
 */
const TOAST_INFO_MS = UI_TOAST_INFO_MS;
const TOAST_ERROR_MS = UI_TOAST_ERROR_MS;

/** Sweep interval for the dismissal timer (see canonical doc in shared/util/timing-constants). */
const TOAST_SWEEP_INTERVAL_MS = UI_TOAST_SWEEP_INTERVAL_MS;

/**
 * Sentinel value meaning "never expires". Used for action toasts that
 * must remain until the user explicitly dismisses them.
 */
const NEVER_EXPIRES = Number.POSITIVE_INFINITY;

interface ActiveToast {
  id: number;
  kind: ToastKind;
  message: string;
  /**
   * Wall-clock deadline in ms, or NEVER_EXPIRES for action toasts.
   * The sweep timer skips entries where expiresAt === NEVER_EXPIRES.
   */
  expiresAt: number;
  /** Action buttons, empty array for plain toasts. */
  actions: ToastAction[];
}

let nextId = 1;
let active: ActiveToast[] = [];
const bus = createListenerBus();

function defaultDuration(kind: ToastKind): number {
  return kind === "error" ? TOAST_ERROR_MS : TOAST_INFO_MS;
}

/** Imperative entry point; safe to call from any module. */
export function showToast(input: ToastInput): void {
  const id = nextId++;
  const actions = input.actions ?? [];

  // Action toasts never expire — they require an explicit user interaction to dismiss.
  const expiresAt =
    actions.length > 0
      ? NEVER_EXPIRES
      : Date.now() + (input.durationMs ?? defaultDuration(input.kind));

  active = [
    ...active,
    {
      id,
      kind: input.kind,
      message: input.message,
      expiresAt,
      actions,
    },
  ];
  bus.notify();
}

function dismiss(id: number): void {
  active = active.filter((t) => t.id !== id);
  bus.notify();
}

/**
 * Mount once at App level. Renders the active toast stack and runs the
 * auto-dismiss timer.
 */
export function ToastRoot(): React.JSX.Element | null {
  const [toasts, setToasts] = useState<ActiveToast[]>(active);

  useEffect(() => {
    return bus.subscribe(() => setToasts([...active]));
  }, []);

  // Single periodic sweep keeps the dismissal logic in one place. We
  // don't bother with per-toast setTimeout — they'd race with manual
  // dismiss + the array would diverge from the timer set.
  // Action toasts (expiresAt === NEVER_EXPIRES) are never swept — only
  // explicit dismiss() calls remove them.
  useEffect(() => {
    if (toasts.length === 0) return;
    const interval = setInterval(() => {
      const now = Date.now();
      const surviving = active.filter((t) => t.expiresAt > now);
      if (surviving.length !== active.length) {
        active = surviving;
        bus.notify();
      }
    }, TOAST_SWEEP_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [toasts.length]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 w-[360px] max-w-[90vw]">
      {toasts.map((t) => {
        // Action toasts use role="alert" (assertive) so assistive technology
        // announces them immediately and the user knows buttons are available.
        // Plain toasts use role="status" (polite) to avoid interrupting flow.
        const hasActions = t.actions.length > 0;
        const role: "alert" | "status" = hasActions ? "alert" : "status";

        return (
          <div
            key={t.id}
            role={role}
            className={cn(
              "flex flex-col gap-2 rounded-(--radius-raised) border px-3 py-2 shadow-none text-app-ui-sm",
              t.kind === "error"
                ? "bg-destructive text-destructive-foreground border-destructive"
                : "bg-popover text-popover-foreground border-border",
            )}
          >
            {/* Message row with dismiss button */}
            <div className="flex items-start gap-2">
              <span className="flex-1 break-words">{t.message}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-5 shrink-0 -mr-1 -mt-0.5 hover:bg-foreground/10"
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss"
              >
                ×
              </Button>
            </div>

            {/* Action buttons — rendered in a dedicated row so they remain
                keyboard-reachable (natural tab order, no z-index tricks). */}
            {hasActions ? (
              <div className="flex items-center gap-2 flex-wrap">
                {t.actions.map((action) => (
                  <Button
                    key={action.label}
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 hover:bg-foreground/10"
                    onClick={() => {
                      action.onAction();
                      dismiss(t.id);
                    }}
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
