import { Dialog as RadixDialog } from "radix-ui";
import { cn } from "@/utils/cn";
import { useDialogFocusReturn } from "./use-dialog-focus-return";

export type DialogSize = "sm" | "md" | "lg" | "xl";

const SIZE_CLASS: Record<DialogSize, string> = {
  sm: "w-[420px]",
  md: "w-[480px]",
  lg: "w-[560px]",
  xl: "w-[720px]",
};

export const DIALOG_OVERLAY_CLASS =
  "dialog-overlay fixed inset-0 z-(--layer-floating) bg-[var(--floating-scrim)]";

export function dialogContentClass(size: DialogSize, padded: boolean, className?: string): string {
  return cn(
    "dialog-content fixed left-1/2 top-1/2 z-(--layer-floating) -translate-x-1/2 -translate-y-1/2 max-w-[90vw]",
    "rounded-(--radius-island) border border-[var(--surface-floating-border)]",
    "bg-popover text-popover-foreground outline-none",
    SIZE_CLASS[size],
    padded && "p-4",
    className,
  );
}

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  size?: DialogSize;
  padded?: boolean;
  className?: string;
  contentStyle?: React.CSSProperties;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  children: React.ReactNode;
}

export function Dialog({
  open,
  onOpenChange,
  size = "md",
  padded = true,
  className,
  contentStyle,
  children,
  ...aria
}: DialogProps): React.JSX.Element {
  const returnFocus = useDialogFocusReturn(open);

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={DIALOG_OVERLAY_CLASS} />
        <RadixDialog.Content
          className={dialogContentClass(size, padded, className)}
          style={contentStyle}
          onCloseAutoFocus={returnFocus}
          {...aria}
        >
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
