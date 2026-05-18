import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { Slot } from "radix-ui";
import type * as React from "react";

import { cn } from "@/utils/cn";

const buttonVariants = cva(
  // Base: inline-flex, no shadow, focus ring uses --ring (ashGray), no colored ring offset
  // Radius: control tier = 4px (design.md §4 — --radius-control, invariant for buttons)
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-(--radius-control) font-medium font-sans transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // ── shadcn standard variants (semantic token hover/active — no opacity hacks) ──
        // hover: state.hover.bg overlay atop primary bg (redundant encoding: surface level change)
        // active: state.active.bg overlay (stronger than hover)
        default:
          "bg-primary text-primary-foreground hover:bg-[var(--state-hover-bg)] active:bg-[var(--state-active-bg)]",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-[var(--state-hover-bg)] active:bg-[var(--state-active-bg)] focus-visible:ring-destructive/20",
        outline:
          "border border-border bg-background hover:bg-[var(--state-hover-bg)] hover:text-foreground active:bg-[var(--state-active-bg)]",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[var(--state-hover-bg)] active:bg-[var(--state-active-bg)]",
        link: "text-primary underline-offset-4 hover:underline",
        // ── ghost: state.hover.bg overlay, no background at rest ──
        ghost:
          "hover:bg-[var(--state-hover-bg)] hover:text-foreground active:bg-[var(--state-active-bg)]",
      },
      size: {
        default: "h-9 px-4 py-2 text-base has-[>svg]:px-3",
        sm: "h-8 px-3 text-sm gap-2 has-[>svg]:px-2",
        lg: "h-10 px-6 text-lg has-[>svg]:px-4",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  loading = false,
  children,
  disabled,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    /** Loading state — shows inline spinner alongside label text (redundant encoding:
     *  indicator shape + disabled interaction, design.md §7 loading state).
     *  Automatically sets disabled when true so pointer-events:none applies. */
    loading?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      disabled={disabled ?? loading}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {loading ? (
        <>
          {/* Spinner: state.loading.indicator color (design.md §7) */}
          <Loader2
            className="animate-spin"
            style={{ color: "var(--state-loading-indicator)" }}
            aria-hidden="true"
          />
          {/* Retain label text — redundant encoding: text + spinner simultaneously */}
          {children}
        </>
      ) : (
        children
      )}
    </Comp>
  );
}

export { Button };
