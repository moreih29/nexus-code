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
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
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

/**
 * Mount once at App level (typically inside the root layout). Reads the
 * head of the prompt queue and shows the dialog.
 */
export function ConflictResolutionDialogRoot(): React.JSX.Element {
  const { t } = useTranslation();
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
    <Dialog open={open} onOpenChange={handleOpenChange} size="md" aria-describedby={undefined}>
      <RadixDialog.Title className="text-app-body-emphasis text-foreground">
        {t("conflictDialog.title", { filename: active?.filename ?? "" })}
      </RadixDialog.Title>
      <RadixDialog.Description className="mt-2 text-app-ui-sm text-muted-foreground">
        {t("conflictDialog.description")}
      </RadixDialog.Description>
      <div className="mt-5 flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => resolveActive("reload")}
          autoFocus={false}
        >
          {t("conflictDialog.reload_from_disk")}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => resolveActive("cancel")}>
          {t("action.cancel")}
        </Button>
        <Button variant="default" size="sm" onClick={() => resolveActive("overwrite")} autoFocus>
          {t("conflictDialog.overwrite")}
        </Button>
      </div>
    </Dialog>
  );
}
