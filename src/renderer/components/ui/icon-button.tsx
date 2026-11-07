/**
 * IconButton — a button that is only an icon: muted at rest, lit on hover,
 * pressed-looking while its menu or popover is open. Its label is both its
 * accessible name and its tooltip, with the shortcut that does the same.
 */

import type * as React from "react";
import { cn } from "@/utils/cn";
import { tooltipProps } from "./tooltip";

const SIZE_CLASS = {
  xs: "size-5",
  sm: "size-6",
  md: "size-7",
  lg: "size-8",
} as const;

export const ICON_BUTTON_CLASS = cn(
  "inline-flex shrink-0 items-center justify-center rounded-(--radius-control)",
  "text-muted-foreground transition-colors",
  "hover:bg-[var(--state-hover-bg)] hover:text-foreground",
  "data-[state=open]:bg-[var(--state-active-bg)] data-[state=open]:text-foreground",
  "disabled:pointer-events-none disabled:opacity-50",
);

export interface IconButtonProps extends Omit<React.ComponentProps<"button">, "title"> {
  /** What the button does: its tooltip and, unless `aria-label` says more, its accessible name. */
  label: string;
  /** The keys that do the same, shown in the tooltip. */
  shortcut?: string | null;
  /** xs 20px, sm 24px (default), md 28px, lg 32px. */
  size?: keyof typeof SIZE_CLASS;
}

export function IconButton({
  label,
  shortcut,
  size = "sm",
  className,
  "aria-label": ariaLabel,
  ...props
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel ?? label}
      {...tooltipProps(label, shortcut)}
      className={cn(ICON_BUTTON_CLASS, SIZE_CLASS[size], className)}
      {...props}
    />
  );
}
