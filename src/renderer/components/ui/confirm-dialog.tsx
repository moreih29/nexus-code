import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { DialogHeader } from "@/components/ui/dialog-header";
import { createListenerBus } from "../../../shared/util/listener-bus";

export const MOUNT_CLICK_GRACE_MS = 120;

export interface ConfirmDialogRequest {
  title: string;
  description: string;
  hint?: string;
  details?: readonly string[];
  cancelLabel?: string;
  confirmLabel?: string;
  variant?: "default" | "destructive";
  signal?: AbortSignal;
}

interface PendingPrompt extends ConfirmDialogRequest {
  resolve: (confirmed: boolean) => void;
}

let queue: PendingPrompt[] = [];
const bus = createListenerBus();

function getActive(): PendingPrompt | null {
  return queue[0] ?? null;
}

export function showConfirmDialog(request: ConfirmDialogRequest): Promise<boolean> {
  return new Promise((resolve) => {
    const { signal } = request;
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const prompt: PendingPrompt = { ...request, resolve };
    signal?.addEventListener("abort", () => withdraw(prompt), { once: true });
    queue.push(prompt);
    bus.notify();
  });
}

function withdraw(prompt: PendingPrompt): void {
  if (!queue.includes(prompt)) return;
  queue = queue.filter((queued) => queued !== prompt);
  prompt.resolve(false);
  bus.notify();
}

function resolveActive(confirmed: boolean): void {
  const active = queue[0];
  if (!active) return;
  queue = queue.slice(1);
  active.resolve(confirmed);
  bus.notify();
}

export const CONFIRM_TEXT_CLASS = "break-keep wrap-break-word";

export function ConfirmDialogRoot(): React.JSX.Element {
  const { t } = useTranslation();
  const [active, setActive] = useState<PendingPrompt | null>(getActive());
  const mountAtRef = useRef<number>(0);

  useEffect(() => {
    return bus.subscribe(() => setActive(getActive()));
  }, []);

  useEffect(() => {
    if (active !== null) mountAtRef.current = performance.now();
  }, [active]);

  const open = active !== null;
  const cancelLabel = active?.cancelLabel ?? t("action.cancel");
  const confirmLabel = active?.confirmLabel ?? t("action.confirm");
  const variant = active?.variant ?? "default";

  const handleOpenChange = (next: boolean): void => {
    if (next) return;
    if (queue[0] === active && active !== null) {
      resolveActive(false);
    }
  };

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
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      size="sm"
      {...(active?.description ? {} : { "aria-describedby": undefined })}
    >
      <DialogHeader
        title={active?.title}
        description={active?.description}
        descriptionClassName={CONFIRM_TEXT_CLASS}
      />
      {active?.details && active.details.length > 0 && (
        <ul className="mt-3 max-h-40 overflow-y-auto rounded-(--radius-control) border border-border px-2 py-1 font-mono text-app-ui-sm text-muted-foreground">
          {active.details.map((line) => (
            <li key={line} className="truncate" title={line}>
              {line}
            </li>
          ))}
        </ul>
      )}
      {active?.hint && (
        <p className={`mt-3 ${CONFIRM_TEXT_CLASS} text-app-ui-sm text-muted-foreground`}>
          {active.hint}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCancelClick}
          autoFocus={variant === "destructive"}
        >
          {cancelLabel}
        </Button>
        <Button
          variant={variant}
          size="sm"
          onClick={handleConfirmClick}
          autoFocus={variant !== "destructive"}
        >
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
