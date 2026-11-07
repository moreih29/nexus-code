/**
 * Popover — a panel opened from a button: what the status bar's ports,
 * problems, encoding and language-server segments and the title bar's
 * update button show. One look (the floating panel) and one behaviour,
 * from Radix: placed against its button and kept in the window, closed by
 * Escape or a press outside, the keyboard back on the button after.
 *
 * Opening puts the keyboard on the panel itself, not its first control,
 * so an Enter meant for the terminal does not press a button in it; Tab
 * goes on into it. Closing puts it back on the button only when nothing
 * else took it: an action that opened a file keeps the keyboard there.
 * A menu of commands is a DropdownMenu instead.
 */

import { Popover as RadixPopover } from "radix-ui";
import { type ReactNode, useRef } from "react";
import { cn } from "@/utils/cn";

export const POPOVER_CLASS = cn(
  "floating-panel z-(--layer-floating) p-1 text-app-ui-sm outline-none",
  "max-h-(--radix-popover-content-available-height) overflow-y-auto app-scrollbar",
);

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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The panel's accessible name. */
  label: string;
  /** The button that opens it; Radix toggles `open` on its click. */
  trigger: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
  /** Width and padding over the default. */
  className?: string;
  testId?: string;
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
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
