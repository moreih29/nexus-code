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
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { createListenerBus } from "../../../shared/util/listener-bus";

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
  const [active, setActive] = useState<PendingPrompt | null>(getActive());

  useEffect(() => {
    return bus.subscribe(() => setActive(getActive()));
  }, []);

  const open = active !== null;
  const cancelLabel = active?.cancelLabel ?? "Cancel";
  const confirmLabel = active?.confirmLabel ?? "Confirm";
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
        <Button variant="ghost" size="sm" onClick={() => resolveActive(false)}>
          {cancelLabel}
        </Button>
        <Button variant={variant} size="sm" onClick={() => resolveActive(true)} autoFocus>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}