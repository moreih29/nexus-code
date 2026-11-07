/**
 * ConfirmDiscardDialog guards destructive discard operations with Cancel first.
 */

import { AlertDialog as RadixAlertDialog } from "radix-ui";
import { useTranslation } from "react-i18next";
import type { GitExpandedGroupKey } from "../../../../../shared/git/types";
import { Button } from "../../../ui/button";
import { DIALOG_OVERLAY_CLASS, dialogContentClass } from "../../../ui/dialog";
import { DialogHeader } from "../../../ui/dialog-header";

export interface DiscardConfirmRequest {
  title: string;
  description: string;
  relPaths: string[];
  source?: GitExpandedGroupKey;
  confirmLabel?: string;
}

interface ConfirmDiscardDialogProps {
  request: DiscardConfirmRequest | null;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (request: DiscardConfirmRequest) => void;
}

export function ConfirmDiscardDialog({
  request,
  busy = false,
  onCancel,
  onConfirm,
}: ConfirmDiscardDialogProps) {
  const { t } = useTranslation("files");
  return (
    <RadixAlertDialog.Root
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <RadixAlertDialog.Portal>
        <RadixAlertDialog.Overlay className={DIALOG_OVERLAY_CLASS} />
        <RadixAlertDialog.Content className={dialogContentClass("sm", true, "flex flex-col")}>
          <DialogHeader
            alert
            title={request?.title ?? t("git.discard.dialogTitle")}
            description={request?.description ?? t("git.discard.dialogDescription")}
          />
          <div className="mt-5 flex justify-end gap-2">
            <RadixAlertDialog.Cancel asChild>
              <Button type="button" variant="ghost" size="sm" autoFocus disabled={busy}>
                {t("git.discard.cancel")}
              </Button>
            </RadixAlertDialog.Cancel>
            <RadixAlertDialog.Action asChild>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => {
                  if (request) onConfirm(request);
                }}
              >
                {request?.confirmLabel ?? t("git.discard.dialogConfirm")}
              </Button>
            </RadixAlertDialog.Action>
          </div>
        </RadixAlertDialog.Content>
      </RadixAlertDialog.Portal>
    </RadixAlertDialog.Root>
  );
}
