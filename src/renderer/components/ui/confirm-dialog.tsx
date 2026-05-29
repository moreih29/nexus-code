/**
 * ConfirmDialog — lightweight confirmation modal.
 *
 * Imperative API (like toast / save-confirm-dialog): callers invoke
 * `showConfirmDialog({ title, description, ... })` and await a boolean.
 * The component is rendered once at App level via ConfirmDialogRoot;
 * there is no per-callsite Dialog.
 *
 * Concurrency: callers may queue prompts back-to-back. A second
 * showConfirmDialog() while one is open queues, and is shown after the
 * first resolves.
 */

import { Dialog as RadixDialog } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { createListenerBus } from "../../../shared/util/listener-bus";

/**
 * Grace window (ms) that suppresses keyboard-synthesized clicks on the dialog
 * buttons immediately after mount. macOS Cmd+Backspace (the file-delete
 * shortcut) emits a residual NSAction in the same event-loop tick that
 * Chromium translates into a `detail: 0` (keyboard-synthesized) click on the
 * first focusable button — which happens to be Cancel — and the dialog
 * dismisses itself before the user ever sees it.
 *
 * Diagnosed by ruling out Radix's `onOpenChange` (never fired) and confirming
 * the call site is the Cancel `onClick` via a React-event stack trace. The
 * fix swallows clicks that (a) arrive within the grace window AND (b) carry
 * `detail === 0` — true mouse clicks (`detail >= 1`) are always honoured.
 *
 * 120 ms is well below human reaction time (~250 ms minimum for a planned
 * key press) so keyboard users who confirm-on-mount only feel one harmless
 * retry; well above the residual NSAction window so the spurious click is
 * reliably absorbed.
 */
const MOUNT_CLICK_GRACE_MS = 120;

export interface ConfirmDialogRequest {
  title: string;
  description: string;
  cancelLabel?: string;
  confirmLabel?: string;
  variant?: "default" | "destructive";
}

interface PendingPrompt extends ConfirmDialogRequest {
  resolve: (confirmed: boolean) => void;
}

let queue: PendingPrompt[] = [];
const bus = createListenerBus();

function getActive(): PendingPrompt | null {
  return queue[0] ?? null;
}

/**
 * Imperative entry point. Resolves to true when the user clicks the
 * confirm button, false on cancel / Esc / backdrop click.
 */
export function showConfirmDialog(request: ConfirmDialogRequest): Promise<boolean> {
  return new Promise((resolve) => {
    queue.push({ ...request, resolve });
    bus.notify();
  });
}

function resolveActive(confirmed: boolean): void {
  const active = queue[0];
  if (!active) return;
  queue = queue.slice(1);
  active.resolve(confirmed);
  bus.notify();
}

/**
 * Mount once at App level. Reads the head of the prompt queue and
 * renders the active confirmation dialog.
 */
export function ConfirmDialogRoot(): React.JSX.Element {
  const { t } = useTranslation();
  const [active, setActive] = useState<PendingPrompt | null>(getActive());
  // Timestamp captured every time a new prompt becomes active — read by
  // the click handlers below to absorb residual keyboard-synthesized
  // clicks. See MOUNT_CLICK_GRACE_MS for the rationale.
  const mountAtRef = useRef<number>(0);

  useEffect(() => {
    return bus.subscribe(() => setActive(getActive()));
  }, []);

  // Re-arm the grace window on every new prompt, not just the very first
  // open — sequential destructive confirms each need protection.
  useEffect(() => {
    if (active !== null) mountAtRef.current = performance.now();
  }, [active]);

  const open = active !== null;
  const cancelLabel = active?.cancelLabel ?? t("action.cancel");
  const confirmLabel = active?.confirmLabel ?? t("action.confirm");
  const variant = active?.variant ?? "default";

  // Esc / backdrop click → cancel. RadixDialog's onOpenChange fires
  // with `false` for both, plus when our buttons trigger a close after
  // a resolve. The guard avoids double-resolving.
  const handleOpenChange = (next: boolean): void => {
    if (next) return;
    if (queue[0] === active && active !== null) {
      resolveActive(false);
    }
  };

  // Drop keyboard-synthesized clicks that fire within the grace window
  // (see MOUNT_CLICK_GRACE_MS doc). `detail === 0` is the standard
  // browser flag for "this click came from a keyboard activation, not a
  // pointer," so true mouse interactions always pass through unaffected.
  const isResidualKeyboardClick = (e: React.MouseEvent): boolean => {
    if (e.detail !== 0) return false;
    return performance.now() - mountAtRef.current < MOUNT_CLICK_GRACE_MS;
  };

  const handleCancelClick = (e: React.MouseEvent): void => {
    if (isResidualKeyboardClick(e)) {
      e.preventDefault();
      return;
    }
    resolveActive(false);
  };

  const handleConfirmClick = (e: React.MouseEvent): void => {
    if (isResidualKeyboardClick(e)) {
      e.preventDefault();
      return;
    }
    resolveActive(true);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange} size="sm" aria-describedby={undefined}>
      <RadixDialog.Title className="text-app-body-emphasis text-foreground">
        {active?.title}
      </RadixDialog.Title>
      {active?.description ? (
        <RadixDialog.Description className="mt-2 text-app-ui-sm text-muted-foreground">
          {active.description}
        </RadixDialog.Description>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={handleCancelClick}>
          {cancelLabel}
        </Button>
        <Button variant={variant} size="sm" onClick={handleConfirmClick} autoFocus>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}