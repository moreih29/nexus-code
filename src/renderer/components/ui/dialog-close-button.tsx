// The × that closes a dialog, for the top-right of a dialog's header. Radix's
// Close fires the dialog's onOpenChange(false), the same path as Esc and an
// outside click. A dialog whose footer already has a Cancel button needs no ×.

import { X } from "lucide-react";
import { Dialog as RadixDialog } from "radix-ui";
import { useTranslation } from "react-i18next";
import { IconButton } from "./icon-button";

interface DialogCloseButtonProps {
  /** The accessible name; defaults to "Close". */
  label?: string;
  className?: string;
}

export function DialogCloseButton({ label, className }: DialogCloseButtonProps) {
  const { t } = useTranslation();
  return (
    <RadixDialog.Close asChild>
      <IconButton label={label ?? t("action.close")} size="md" className={className}>
        <X className="size-4" aria-hidden="true" />
      </IconButton>
    </RadixDialog.Close>
  );
}
