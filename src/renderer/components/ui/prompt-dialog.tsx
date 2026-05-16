/**
 * PromptDialog — renderer-side single-line input dialog.
 *
 * Replaces window.prompt(), which Electron's BrowserWindow disables. The
 * component is contract-only: callers pass a request descriptor and confirm
 * callback; cancel and overlay-click both close via onCancel.
 */

import { Dialog as RadixDialog } from "radix-ui";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "./button";

export interface PromptRequest {
  title: string;
  description?: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  /**
   * `none` turns the dialog into a confirm-only prompt for flows where an
   * editable value would misrepresent the action being confirmed.
   */
  inputMode?: "text" | "none";
  /** Allows confirmation with an empty value for optional-message prompts. */
  allowEmpty?: boolean;
}

interface PromptDialogProps {
  request: PromptRequest | null;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}

export function PromptDialog({ request, busy = false, onCancel, onConfirm }: PromptDialogProps) {
  const [value, setValue] = useState("");
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const showInput = request?.inputMode !== "none";

  useEffect(() => {
    setValue(request?.defaultValue ?? "");
  }, [request]);

  useEffect(() => {
    if (!request || request.inputMode === "none") return;
    inputRef.current?.focus();
  }, [request]);

  const trimmed = value.trim();
  const confirmDisabled =
    busy || (showInput && request?.allowEmpty !== true && trimmed.length === 0);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (confirmDisabled) return;
    onConfirm(showInput ? trimmed : "");
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
        <RadixDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[420px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-[--radius-container] border border-border bg-background p-5 text-foreground shadow-none outline-none">
          <RadixDialog.Title className="text-app-body-emphasis text-foreground">
            {request?.title ?? ""}
          </RadixDialog.Title>
          {request?.description ? (
            <RadixDialog.Description className="mt-2 text-app-ui-sm text-muted-foreground">
              {request.description}
            </RadixDialog.Description>
          ) : null}
          <form className="mt-4 flex flex-col gap-2" onSubmit={handleSubmit}>
            {showInput ? (
              <>
                {request?.label ? (
                  <label htmlFor={inputId} className="text-app-ui-sm text-foreground">
                    {request.label}
                  </label>
                ) : null}
                <input
                  ref={inputRef}
                  id={inputId}
                  type="text"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder={request?.placeholder}
                  className="w-full rounded-[--radius-control] border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  disabled={busy}
                />
              </>
            ) : null}
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
