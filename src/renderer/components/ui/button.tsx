import type * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  // Base: inline-flex, no shadow, focus ring uses --ring (ashGray), no colored ring offset
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap font-medium font-sans transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // ── shadcn standard variants (Warp-tuned: no shadow, warm gray palette) ──
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20",
        outline:
          "border border-border bg-background hover:bg-[--color-frosted-veil] hover:text-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        link: "text-primary underline-offset-4 hover:underline",
        // ── ghost: frostedVeil hover, no background at rest ──
        ghost: "hover:bg-[--color-frosted-veil] hover:text-foreground",
        // ── pill: earthGray bg, warmParchment text, 50px radius ──
        pill: "rounded-[50px] bg-primary text-primary-foreground hover:bg-primary/90 py-[10px] px-[10px]",
        // ── frostedTag: translucent white bg, dark text, 6px radius, tight padding ──
        frostedTag:
          "rounded-[6px] bg-[--color-frosted-tag] text-black hover:bg-[--color-frosted-tag-hover] py-[1px] px-[6px] text-xs",
      },
      size: {
        default: "h-9 px-4 py-2 text-base has-[>svg]:px-3",
        sm: "h-8 px-3 text-sm gap-1.5 has-[>svg]:px-2.5",
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
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
