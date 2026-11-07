// The × that closes a dialog, for the top-right of a dialog's header. Radix's
// Close fires the dialog's onOpenChange(false), the same path as Esc and an
// outside click. A dialog whose footer already has a Cancel button needs no ×.

import { X } from "lucide-react";
import { Dialog as RadixDialog } from "radix-ui";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";

interface DialogCloseButtonProps {
  /** The accessible name; defaults to "Close". */
  label?: string;
  className?: string;
}

export function DialogCloseButton({ label, className }: DialogCloseButtonProps) {
  const { t } = useTranslation();
  return (
    <RadixDialog.Close asChild>
      <button
        type="button"
        aria-label={label ?? t("action.close")}
        className={cn(
          "inline-flex size-7 shrink-0 items-center justify-center rounded-(--radius-control)",
          "text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground",
          "transition-colors",
          className,
        )}
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </RadixDialog.Close>
  );
}
