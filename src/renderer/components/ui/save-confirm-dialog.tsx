// In-app three-option save confirmation modal — Save / Don't Save / Cancel.
//
// Imperative API: callers invoke `showSaveConfirm(filename)` and await
// the user's choice. The component itself is rendered once at App level
// (SaveConfirmDialogRoot) and renders the active prompt — there is no
// per-callsite Dialog.
//
// Concurrency: callers may queue prompts back-to-back (e.g. close-all
// across multiple dirty tabs). We serialize them: a second
// showSaveConfirm() while another is open queues, and is shown when the
// first resolves.

import { Dialog as RadixDialog } from "radix-ui";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export type SaveConfirmChoice = "save" | "dont-save" | "cancel";

interface PendingPrompt {
  filename: string;
  resolve: (choice: SaveConfirmChoice) => void;
}

let queue: PendingPrompt[] = [];
const subscribers = new Set<() => void>();

function notify(): void {
  for (const fn of subscribers) fn();
}

function getActive(): PendingPrompt | null {
  return queue[0] ?? null;
}

function pushPrompt(filename: string): Promise<SaveConfirmChoice> {
  return new Promise((resolve) => {
    queue.push({ filename, resolve });
    notify();
  });
}

function resolveActive(choice: SaveConfirmChoice): void {
  const active = queue[0];
  if (!active) return;
  queue = queue.slice(1);
  active.resolve(choice);
  notify();
}

/**
 * Imperative entry point. Resolves to the user's choice. Cancel is the
 * default if the dialog is dismissed via Esc or backdrop click.
 */
export function showSaveConfirm(filename: string): Promise<SaveConfirmChoice> {
  return pushPrompt(filename);
}

// Test helper — clears the queue to avoid cross-test bleed.
export function __resetSaveConfirmForTests(): void {
  for (const p of queue) p.resolve("cancel");
  queue = [];
  notify();
}

/**
 * Mount once at App level (typically inside the root layout). Reads the
 * head of the prompt queue and shows the dialog.
 */
export function SaveConfirmDialogRoot(): React.JSX.Element {
  const [active, setActive] = useState<PendingPrompt | null>(getActive());

  useEffect(() => {
    const listener = () => setActive(getActive());
    subscribers.add(listener);
    return () => {
      subscribers.delete(listener);
    };
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
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[420px] max-w-[90vw] rounded-md border border-border bg-background p-5 shadow-lg outline-none"
          aria-describedby={undefined}
        >
          <RadixDialog.Title className="text-app-ui-md font-medium text-foreground">
            Do you want to save the changes you made to{" "}
            <span className="font-mono">{active?.filename}</span>?
          </RadixDialog.Title>
          <RadixDialog.Description className="mt-2 text-app-ui-sm text-muted-foreground">
            Your changes will be lost if you don't save them.
          </RadixDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => resolveActive("dont-save")}
              autoFocus={false}
            >
              Don't Save
            </Button>
            <Button variant="ghost" size="sm" onClick={() => resolveActive("cancel")}>
              Cancel
            </Button>
            <Button variant="default" size="sm" onClick={() => resolveActive("save")} autoFocus>
              Save
            </Button>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
