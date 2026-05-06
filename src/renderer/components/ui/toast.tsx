/**
 * Lightweight in-app toast.
 *
 * Imperative API: callers anywhere call `showToast({ kind, message })`
 * and a styled toast appears in the bottom-right stack. Auto-dismisses
 * on a timer; users can also click × to dismiss.
 *
 * Why custom (not Radix Toast): we already follow the imperative-API
 * + singleton-Root pattern from save-confirm-dialog. Toast doesn't need
 * focus management or aria-live trickery for the cases it serves
 * (filesystem operation feedback) — `role="status"` is sufficient.
 *
 * Module is a singleton store + a Root component. The store keeps the
 * active toast list; the Root subscribes to it and re-renders on
 * change. No React context — toasts can be triggered from non-React
 * code paths (services, IPC error handlers).
 */

import { useEffect, useState } from "react";
import {
  UI_TOAST_ERROR_MS,
  UI_TOAST_INFO_MS,
  UI_TOAST_SWEEP_INTERVAL_MS,
} from "../../../shared/timing-constants";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/cn";

export type ToastKind = "info" | "error";

export interface ToastInput {
  kind: ToastKind;
  message: string;
  /** Override auto-dismiss in ms. Defaults: see TOAST_INFO_MS / TOAST_ERROR_MS. */
  durationMs?: number;
}

/**
 * Default auto-dismiss durations. Errors hold longer so the user can
 * still read the toast after switching focus to investigate.
 *
 * Re-exported under toast-local names so existing callers stay unchanged.
 * See `shared/timing-constants.ts` for the canonical definitions.
 */
export const TOAST_INFO_MS = UI_TOAST_INFO_MS;
export const TOAST_ERROR_MS = UI_TOAST_ERROR_MS;

/** Sweep interval for the dismissal timer (see canonical doc in shared/timing-constants). */
const TOAST_SWEEP_INTERVAL_MS = UI_TOAST_SWEEP_INTERVAL_MS;

interface ActiveToast {
  id: number;
  kind: ToastKind;
  message: string;
  /** Wall-clock deadline in ms. */
  expiresAt: number;
}

let nextId = 1;
let active: ActiveToast[] = [];
const subscribers = new Set<() => void>();

function notify(): void {
  for (const fn of subscribers) fn();
}

function defaultDuration(kind: ToastKind): number {
  return kind === "error" ? TOAST_ERROR_MS : TOAST_INFO_MS;
}

/** Imperative entry point; safe to call from any module. */
export function showToast(input: ToastInput): void {
  const id = nextId++;
  const duration = input.durationMs ?? defaultDuration(input.kind);
  active = [
    ...active,
    {
      id,
      kind: input.kind,
      message: input.message,
      expiresAt: Date.now() + duration,
    },
  ];
  notify();
}

function dismiss(id: number): void {
  active = active.filter((t) => t.id !== id);
  notify();
}

// Test helper — clears the queue between tests.
export function __resetToastsForTests(): void {
  active = [];
  notify();
}

/**
 * Mount once at App level. Renders the active toast stack and runs the
 * auto-dismiss timer.
 */
export function ToastRoot(): React.JSX.Element | null {
  const [toasts, setToasts] = useState<ActiveToast[]>(active);

  useEffect(() => {
    const listener = () => setToasts([...active]);
    subscribers.add(listener);
    return () => {
      subscribers.delete(listener);
    };
  }, []);

  // Single periodic sweep keeps the dismissal logic in one place. We
  // don't bother with per-toast setTimeout — they'd race with manual
  // dismiss + the array would diverge from the timer set.
  useEffect(() => {
    if (toasts.length === 0) return;
    const interval = setInterval(() => {
      const now = Date.now();
      const surviving = active.filter((t) => t.expiresAt > now);
      if (surviving.length !== active.length) {
        active = surviving;
        notify();
      }
    }, TOAST_SWEEP_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [toasts.length]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 w-[360px] max-w-[90vw]">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cn(
            "flex items-start gap-2 rounded-md border px-3 py-2 shadow-md text-app-ui-sm",
            t.kind === "error"
              ? "bg-destructive text-destructive-foreground border-destructive"
              : "bg-popover text-popover-foreground border-mist-border",
          )}
        >
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
      ))}
    </div>
  );
}
