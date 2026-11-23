import { useTranslation } from "react-i18next";
import { Button } from "./button";

const INLINE_CONFIRM_BUTTON_CLASS =
  "h-6 shrink-0 whitespace-nowrap px-2 text-app-ui-sm focus-visible:ring-0 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground/60";

interface InlineConfirmButtonsProps {
  confirmLabel?: string;
  busyLabel?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function InlineConfirmButtons({
  confirmLabel,
  busyLabel,
  busy = false,
  onCancel,
  onConfirm,
}: InlineConfirmButtonsProps) {
  const { t } = useTranslation();
  const label = confirmLabel ?? t("action.delete");
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className={INLINE_CONFIRM_BUTTON_CLASS}
        disabled={busy}
        onClick={onCancel}
      >
        {t("action.cancel")}
      </Button>
      <Button
        variant="destructive"
        size="sm"
        className={INLINE_CONFIRM_BUTTON_CLASS}
        autoFocus
        disabled={busy}
        onClick={onConfirm}
      >
        {busy && busyLabel ? busyLabel : label}
      </Button>
    </>
  );
}
