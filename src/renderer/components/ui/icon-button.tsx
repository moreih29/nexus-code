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
  label: string;
  shortcut?: string | null;
  size?: keyof typeof SIZE_CLASS;
  blocked?: boolean;
}

export function IconButton({
  label,
  shortcut,
  size = "sm",
  blocked = false,
  className,
  "aria-label": ariaLabel,
  onClick,
  ...props
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel ?? label}
      aria-disabled={blocked || undefined}
      {...tooltipProps(label, shortcut)}
      className={cn(
        ICON_BUTTON_CLASS,
        SIZE_CLASS[size],
        blocked && "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground",
        className,
      )}
      onClick={blocked ? undefined : onClick}
      {...props}
    />
  );
}
