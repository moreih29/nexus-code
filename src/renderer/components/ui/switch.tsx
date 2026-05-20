// src/renderer/components/ui/switch.tsx — Token-sealed toggle switch primitive.
//
// Thin wrapper over Radix Switch that mirrors the checkbox.tsx pattern:
// semantic tokens throughout, no hex/rgba/oklch literals, no shadows.
//
// Design seal: control-radius pill track + state.selected.* fill when on.

import { Switch as RadixSwitch } from "radix-ui";
import type * as React from "react";
import { cn } from "@/utils/cn";

function Switch({ className, ...props }: React.ComponentProps<typeof RadixSwitch.Root>) {
  return (
    <RadixSwitch.Root
      className={cn(
        // Track — pill shape, 32×18px (w-8 h-[18px])
        "inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center",
        "rounded-full border border-border bg-muted",
        "outline-none transition-colors",
        "hover:bg-[var(--state-hover-bg)]",
        "focus-visible:ring-1 focus-visible:ring-ring",
        // Checked: fill track with selected bg token
        "data-[state=checked]:bg-[var(--state-selected-bg)] data-[state=checked]:border-[var(--state-selected-bg)]",
        "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <RadixSwitch.Thumb
        className={cn(
          // Thumb — 14px circle with 2px padding (translate-x-0.5 ↔ translate-x-[14px])
          "pointer-events-none block size-[14px] rounded-full bg-background shadow-none",
          "transition-transform duration-200",
          "data-[state=unchecked]:translate-x-0.5",
          "data-[state=checked]:translate-x-[14px]",
        )}
      />
    </RadixSwitch.Root>
  );
}

export { Switch };
