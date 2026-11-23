import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { DialogHeader } from "@/components/ui/dialog-header";
import { createListenerBus } from "../../../shared/util/listener-bus";

export type SaveConfirmChoice = "save" | "dont-save" | "cancel";

interface PendingPrompt {
  filename: string;
  resolve: (choice: SaveConfirmChoice) => void;
}

let queue: PendingPrompt[] = [];
const bus = createListenerBus();

function getActive(): PendingPrompt | null {
  return queue[0] ?? null;
}

function pushPrompt(filename: string): Promise<SaveConfirmChoice> {
  return new Promise((resolve) => {
    queue.push({ filename, resolve });
    bus.notify();
  });
}

function resolveActive(choice: SaveConfirmChoice): void {
  const active = queue[0];
  if (!active) return;
  queue = queue.slice(1);
  active.resolve(choice);
  bus.notify();
}

export function showSaveConfirm(filename: string): Promise<SaveConfirmChoice> {
  return pushPrompt(filename);
}

export function SaveConfirmDialogRoot(): React.JSX.Element {
  const { t } = useTranslation();
  const [active, setActive] = useState<PendingPrompt | null>(getActive());

  useEffect(() => {
    return bus.subscribe(() => setActive(getActive()));
  }, []);

  const open = active !== null;

  const handleOpenChange = (next: boolean): void => {
    if (next) return;
    if (queue[0] === active && active !== null) {
      resolveActive("cancel");
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange} size="sm">
      <DialogHeader
        title={t("saveConfirm.title", { filename: active?.filename ?? "" })}
        description={t("saveConfirm.description")}
      />
      <div className="mt-5 flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => resolveActive("dont-save")}
          autoFocus={false}
        >
          {t("saveConfirm.dont_save")}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => resolveActive("cancel")}>
          {t("action.cancel")}
        </Button>
        <Button variant="default" size="sm" onClick={() => resolveActive("save")} autoFocus>
          {t("action.save")}
        </Button>
      </div>
    </Dialog>
  );
}
