// In-app workspace removal confirmation modal — L3 surface (design.md §2).
//
// Imperative API: callers invoke `showRemoveWorkspaceConfirm(name)` and await
// the boolean result. The component is rendered once at App level via
// RemoveWorkspaceDialogRoot and renders the active prompt.
//
// Replaces window.confirm in app.tsx:handleRemoveWorkspace.

import { Dialog as RadixDialog } from "radix-ui";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { createListenerBus } from "../../../shared/util/listener-bus";

interface PendingPrompt {
  name: string;
  resolve: (confirmed: boolean) => void;
}

let queue: PendingPrompt[] = [];
const bus = createListenerBus();

function getActive(): PendingPrompt | null {
  return queue[0] ?? null;
}

function pushPrompt(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    queue.push({ name, resolve });
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
 * Imperative entry point. Resolves to `true` (confirmed remove) or `false`
 * (cancelled). Esc / backdrop click resolves to `false`.
 */
export function showRemoveWorkspaceConfirm(name: string): Promise<boolean> {
  return pushPrompt(name);
}

/**
 * Mount once at App level inside GlobalRoots. Reads the head of the prompt
 * queue and shows the confirmation dialog.
 */
export function RemoveWorkspaceDialogRoot(): React.JSX.Element {
  const [active, setActive] = useState<PendingPrompt | null>(getActive());

  useEffect(() => {
    return bus.subscribe(() => setActive(getActive()));
  }, []);

  const open = active !== null;

  const handleOpenChange = (next: boolean): void => {
    if (next) return;
    if (queue[0] === active && active !== null) {
      resolveActive(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange} size="sm" aria-describedby={undefined}>
      <RadixDialog.Title className="text-app-body-emphasis text-foreground">
        Remove <span className="font-medium">&ldquo;{active?.name}&rdquo;</span> from Nexus?
      </RadixDialog.Title>
      <RadixDialog.Description className="mt-2 text-app-ui-sm text-muted-foreground">
        The folder on disk is not touched. Only the workspace registration is removed.
      </RadixDialog.Description>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => resolveActive(false)}>
          Cancel
        </Button>
        <Button variant="default" size="sm" onClick={() => resolveActive(true)} autoFocus>
          Remove
        </Button>
      </div>
    </Dialog>
  );
}
