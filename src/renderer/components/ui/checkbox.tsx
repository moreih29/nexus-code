import { Check } from "lucide-react";
import { Checkbox as RadixCheckbox } from "radix-ui";
import type * as React from "react";
import { cn } from "@/utils/cn";

function Checkbox({ className, ...props }: React.ComponentProps<typeof RadixCheckbox.Root>) {
  return (
    <RadixCheckbox.Root
      className={cn(
        "peer inline-flex size-4 shrink-0 items-center justify-center",
        "rounded-(--radius-control) border border-border bg-background",
        "outline-none transition-colors",
        "hover:bg-[var(--state-hover-bg)]",
        "focus-visible:ring-1 focus-visible:ring-ring",
        "data-[state=checked]:bg-[var(--state-selected-bg)] data-[state=checked]:border-[var(--state-selected-bg)]",
        "data-[state=checked]:text-[var(--state-selected-fg)]",
        "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <RadixCheckbox.Indicator className="inline-flex items-center justify-center">
        <Check className="size-3" aria-hidden="true" />
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );
}

export { Checkbox };
