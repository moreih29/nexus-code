/**
 * ConfirmDiscardDialog guards destructive discard operations with Cancel first.
 */

import { AlertDialog as RadixAlertDialog } from "radix-ui";
import type { GitExpandedGroupKey } from "../../../../shared/types/git";
import { Button } from "../../ui/button";

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
  return (
    <RadixAlertDialog.Root
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <RadixAlertDialog.Portal>
        <RadixAlertDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <RadixAlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[420px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-md border border-mist-border bg-background p-5 text-foreground shadow-lg outline-none">
          <RadixAlertDialog.Title className="text-app-body-emphasis text-foreground">
            {request?.title ?? "Discard changes?"}
          </RadixAlertDialog.Title>
          <RadixAlertDialog.Description className="mt-2 text-app-ui-sm text-muted-foreground">
            {request?.description ?? "This cannot be undone."}
          </RadixAlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <RadixAlertDialog.Cancel asChild>
              <Button type="button" variant="ghost" size="sm" autoFocus disabled={busy}>
                Cancel
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
                {request?.confirmLabel ?? "Discard"}
              </Button>
            </RadixAlertDialog.Action>
          </div>
        </RadixAlertDialog.Content>
      </RadixAlertDialog.Portal>
    </RadixAlertDialog.Root>
  );
}
