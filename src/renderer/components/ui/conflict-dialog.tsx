// In-app three-option conflict resolution modal — Overwrite / Reload / Cancel.
//
// Imperative API: callers invoke `showConflictResolution(filename)` and await
// the user's choice. The component itself is rendered once at App level
// (ConflictResolutionDialogRoot) and renders the active prompt — there is no
// per-callsite Dialog.
//
// Concurrency: callers may queue prompts back-to-back. We serialize them: a
// second showConflictResolution() while another is open queues, and is shown
// when the first resolves.

import { Dialog as RadixDialog } from "radix-ui";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { createListenerBus } from "../../../shared/util/listener-bus";

export type ConflictResolutionChoice = "overwrite" | "reload" | "cancel";

interface PendingPrompt {
  filename: string;
  resolve: (choice: ConflictResolutionChoice) => void;
}

let queue: PendingPrompt[] = [];
const bus = createListenerBus();

function getActive(): PendingPrompt | null {
  return queue[0] ?? null;
}

function pushPrompt(filename: string): Promise<ConflictResolutionChoice> {
  return new Promise((resolve) => {
    queue.push({ filename, resolve });
    bus.notify();
  });
}

function resolveActive(choice: ConflictResolutionChoice): void {
  const active = queue[0];
  if (!active) return;
  queue = queue.slice(1);
  active.resolve(choice);
  bus.notify();
}

/**
 * Imperative entry point. Resolves to the user's choice. Cancel is the
 * default if the dialog is dismissed via Esc or backdrop click.
 */
export function showConflictResolution(filename: string): Promise<ConflictResolutionChoice> {
  return pushPrompt(filename);
}

// Test helper — clears the queue to avoid cross-test bleed.
export function __resetConflictDialogForTests(): void {
  for (const p of queue) p.resolve("cancel");
  queue = [];
  bus.notify();
  bus.clear();
}

/**
 * Mount once at App level (typically inside the root layout). Reads the
 * head of the prompt queue and shows the dialog.
 */
export function ConflictResolutionDialogRoot(): React.JSX.Element {
  const [active, setActive] = useState<PendingPrompt | null>(getActive());

  useEffect(() => {
    return bus.subscribe(() => setActive(getActive()));
  }, []);

  const open = active !== null;

  // Esc / backdrop click → cancel. RadixDialog's onOpenChange fires
  // with `false` for both, plus when our buttons trigger a close after
  // a resolve. The guard avoids double-resolving.
  const handleOpenChange = (next: boolean): void => {
    if (next) return;
    if (queue[0] === active && active !== null) {
      resolveActive("cancel");
    }
  };

  return (
    <RadixDialog.Root open={open} onOpenChange={handleOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 bg-black/40 z-50" />
        <RadixDialog.Content
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[440px] max-w-[90vw] rounded-md border border-border bg-background p-5 shadow-lg outline-none"
          aria-describedby={undefined}
        >
          <RadixDialog.Title className="text-app-ui-md font-medium text-foreground">
            Save conflict — <span className="font-mono">{active?.filename}</span> changed on disk
          </RadixDialog.Title>
          <RadixDialog.Description className="mt-2 text-app-ui-sm text-muted-foreground">
            The file was modified on disk after you started editing. Choose how to resolve the
            conflict.
          </RadixDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => resolveActive("reload")}
              autoFocus={false}
            >
              Reload from Disk
            </Button>
            <Button variant="ghost" size="sm" onClick={() => resolveActive("cancel")}>
              Cancel
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => resolveActive("overwrite")}
              autoFocus
            >
              Overwrite
            </Button>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
