/**
 * PromptDialog — renderer-side single-line input dialog.
 *
 * Replaces window.prompt(), which Electron's BrowserWindow disables. The
 * component is contract-only: callers pass a request descriptor and confirm
 * callback; cancel and overlay-click both close via onCancel.
 */

import { Dialog as RadixDialog } from "radix-ui";
import { useEffect, useState } from "react";
import { Button } from "./button";

export interface PromptRequest {
  title: string;
  description?: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
}

interface PromptDialogProps {
  request: PromptRequest | null;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}

export function PromptDialog({
  request,
  busy = false,
  onCancel,
  onConfirm,
}: PromptDialogProps) {
  const [value, setValue] = useState("");

  useEffect(() => {
    setValue(request?.defaultValue ?? "");
  }, [request]);

  const trimmed = value.trim();
  const confirmDisabled = busy || trimmed.length === 0;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (confirmDisabled) return;
    onConfirm(trimmed);
  }

  return (
    <RadixDialog.Root
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <RadixDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[420px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-md border border-mist-border bg-background p-5 text-foreground shadow-lg outline-none">
          <RadixDialog.Title className="text-app-body-emphasis text-foreground">
            {request?.title ?? ""}
          </RadixDialog.Title>
          {request?.description ? (
            <RadixDialog.Description className="mt-2 text-app-ui-sm text-muted-foreground">
              {request.description}
            </RadixDialog.Description>
          ) : null}
          <form className="mt-4 flex flex-col gap-2" onSubmit={handleSubmit}>
            {request?.label ? (
              <label className="text-app-ui-sm text-foreground">{request.label}</label>
            ) : null}
            <input
              type="text"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={request?.placeholder}
              className="w-full rounded-sm border border-mist-border bg-background px-2 py-1 text-app-body text-foreground outline-none focus-visible:ring-1 focus-visible:ring-mist-border-focus"
              autoFocus
              disabled={busy}
            />
            <div className="mt-3 flex justify-end gap-2">
              <RadixDialog.Close asChild>
                <Button type="button" variant="ghost" size="sm" disabled={busy}>
                  Cancel
                </Button>
              </RadixDialog.Close>
              <Button type="submit" size="sm" disabled={confirmDisabled}>
                {request?.confirmLabel ?? "OK"}
              </Button>
            </div>
          </form>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
