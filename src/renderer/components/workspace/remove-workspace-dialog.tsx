import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { MOUNT_CLICK_GRACE_MS } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { DialogHeader } from "@/components/ui/dialog-header";
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

export function showRemoveWorkspaceConfirm(
  name: string,
  unsavedCount = 0,
  taskCount = 0,
): Promise<boolean> {
  return pushPrompt(name, unsavedCount, taskCount);
}

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
    <Dialog open={open} onOpenChange={handleOpenChange} size="sm">
      <DialogHeader
        title={t("workspace.remove_title", { name: active?.name ?? "" })}
        description={
          <>
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
          </>
        }
      />
      <div className="mt-5 flex justify-end gap-2">
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
