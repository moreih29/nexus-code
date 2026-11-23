import { Popover as RadixPopover } from "radix-ui";
import { type ReactNode, type SyntheticEvent, useRef } from "react";
import { cn } from "@/utils/cn";

export const POPOVER_CLASS = cn(
  "floating-panel z-(--layer-floating) p-1 text-app-ui-sm outline-none",
  "max-h-(--radix-popover-content-available-height) overflow-y-auto app-scrollbar",
);

function stopPropagation(event: SyntheticEvent): void {
  event.stopPropagation();
}

const CONTAINED = {
  onClick: stopPropagation,
  onDoubleClick: stopPropagation,
  onContextMenu: stopPropagation,
  onKeyDown: stopPropagation,
} as const;

export function Popover({
  open,
  onOpenChange,
  label,
  trigger,
  children,
  side = "top",
  align = "end",
  className,
  testId,
  containEvents = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  trigger: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
  className?: string;
  testId?: string;
  containEvents?: boolean;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          ref={contentRef}
          role="dialog"
          aria-label={label}
          side={side}
          align={align}
          sideOffset={4}
          collisionPadding={8}
          tabIndex={-1}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            contentRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            const focused = document.activeElement;
            if (focused && focused !== document.body) event.preventDefault();
          }}
          data-testid={testId}
          className={cn(POPOVER_CLASS, className)}
          {...(containEvents ? CONTAINED : {})}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
