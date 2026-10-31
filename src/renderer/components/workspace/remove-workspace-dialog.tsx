// In-app workspace removal confirmation modal — L3 surface (design.md §2).
//
// Imperative API: callers invoke `showRemoveWorkspaceConfirm(name)` and await
// the boolean result. The component is rendered once at App level via
// RemoveWorkspaceDialogRoot and renders the active prompt.
//
// Replaces window.confirm in app.tsx:handleRemoveWorkspace.

import { Dialog as RadixDialog } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { MOUNT_CLICK_GRACE_MS } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { createListenerBus } from "../../../shared/util/listener-bus";

interface PendingPrompt {
  name: string;
  unsavedCount: number;
  taskCount: number;
  resolve: (confirmed: boolean) => void;
}

let queue: PendingPrompt[] = [];
const bus = createListenerBus();

function getActive(): PendingPrompt | null {
  return queue[0] ?? null;
}

function pushPrompt(name: string, unsavedCount: number, taskCount: number): Promise<boolean> {
  return new Promise((resolve) => {
    queue.push({ name, unsavedCount, taskCount, resolve });
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
 * (cancelled). Esc / backdrop click resolves to `false`. `unsavedCount` is
 * the number of the workspace's buffers whose edits removal will discard;
 * `taskCount` the number of its tasks that close with it.
 */
export function showRemoveWorkspaceConfirm(
  name: string,
  unsavedCount = 0,
  taskCount = 0,
): Promise<boolean> {
  return pushPrompt(name, unsavedCount, taskCount);
}

/**
 * Mount once at App level inside GlobalRoots. Reads the head of the prompt
 * queue and shows the confirmation dialog.
 */
export function RemoveWorkspaceDialogRoot(): React.JSX.Element {
  const { t } = useTranslation();
  const [active, setActive] = useState<PendingPrompt | null>(getActive());
  const mountAtRef = useRef<number>(0);

  useEffect(() => {
    return bus.subscribe(() => setActive(getActive()));
  }, []);

  useEffect(() => {
    if (active !== null) mountAtRef.current = performance.now();
  }, [active]);

  // Same guard as ConfirmDialog: a keyboard-synthesized click (`detail`
  // 0) right after the dialog opens is the residue of the key that opened
  // it, not an answer.
  const answer =
    (confirmed: boolean) =>
    (e: React.MouseEvent): void => {
      if (e.detail === 0 && performance.now() - mountAtRef.current < MOUNT_CLICK_GRACE_MS) {
        e.preventDefault();
        return;
      }
      resolveActive(confirmed);
    };

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
        {t("workspace.remove_title", { name: active?.name ?? "" })}
      </RadixDialog.Title>
      <RadixDialog.Description className="mt-2 text-app-ui-sm text-muted-foreground">
        {t("workspace.remove_description")}
        {active !== null && active.taskCount > 0 && (
          <span className="mt-2 block text-foreground">
            {t("workspace.remove_tasks", { count: active.taskCount })}
          </span>
        )}
        {active !== null && active.unsavedCount > 0 && (
          <span className="mt-2 block text-foreground">
            {t("workspace.remove_unsaved", { count: active.unsavedCount })}
          </span>
        )}
      </RadixDialog.Description>
      <div className="mt-5 flex justify-end gap-2">
        {/* Focus starts on Cancel: the dialog often opens from a key press
            (Enter on the sidebar's remove button), and key repeat or a
            second Enter must not remove the workspace, kill its terminals
            and discard its unsaved edits. */}
        <Button variant="ghost" size="sm" onClick={answer(false)} autoFocus>
          {t("action.cancel")}
        </Button>
        <Button variant="default" size="sm" onClick={answer(true)}>
          {t("action.remove")}
        </Button>
      </div>
    </Dialog>
  );
}
