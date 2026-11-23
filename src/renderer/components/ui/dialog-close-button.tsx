import { X } from "lucide-react";
import { Dialog as RadixDialog } from "radix-ui";
import { useTranslation } from "react-i18next";
import { IconButton } from "./icon-button";

interface DialogCloseButtonProps {
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
