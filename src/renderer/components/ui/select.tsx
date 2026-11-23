import { Check, ChevronDown } from "lucide-react";
import { Select as RadixSelect } from "radix-ui";
import type * as React from "react";
import { cn } from "@/utils/cn";

interface SelectTriggerProps extends React.ComponentProps<typeof RadixSelect.Trigger> {
  placeholder?: string;
  ariaLabel?: string;
}

function SelectTrigger({ className, children, ariaLabel, ...props }: SelectTriggerProps) {
  return (
    <RadixSelect.Trigger
      aria-label={ariaLabel}
      className={cn(
        "inline-flex w-full items-center justify-between gap-2",
        "rounded-(--radius-control) border border-border bg-background px-2 py-1",
        "text-app-body text-foreground outline-none",
        "hover:bg-[var(--state-hover-bg)]",
        "focus-visible:ring-1 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "[&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {children}
      <RadixSelect.Icon asChild>
        <ChevronDown className="text-muted-foreground" aria-hidden="true" />
      </RadixSelect.Icon>
    </RadixSelect.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: React.ComponentProps<typeof RadixSelect.Content>) {
  return (
    <RadixSelect.Portal>
      <RadixSelect.Content
        position={position}
        className={cn(
          "z-(--layer-floating) max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)]",
          "overflow-hidden rounded-(--radius-island)",
          "border border-[var(--surface-floating-border)] bg-popover text-popover-foreground",
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1",
          className,
        )}
        {...props}
      >
        <RadixSelect.Viewport className="p-1">{children}</RadixSelect.Viewport>
      </RadixSelect.Content>
    </RadixSelect.Portal>
  );
}

function SelectItem({
  className,
  children,
  description,
  ...props
}: React.ComponentProps<typeof RadixSelect.Item> & {
  description?: React.ReactNode;
}) {
  return (
    <RadixSelect.Item
      className={cn(
        "relative flex w-full cursor-pointer select-none items-center gap-2",
        "rounded-(--radius-control) px-2 py-1 pr-8 text-app-body outline-none",
        "data-[highlighted]:bg-[var(--state-hover-bg)] data-[highlighted]:text-foreground",
        "data-[state=checked]:bg-[var(--state-selected-bg)] data-[state=checked]:text-[var(--state-selected-fg)]",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      {description === undefined ? (
        <RadixSelect.ItemText>{children}</RadixSelect.ItemText>
      ) : (
        <span className="flex min-w-0 flex-col">
          <RadixSelect.ItemText>{children}</RadixSelect.ItemText>
          <span className="truncate text-app-ui-sm text-muted-foreground">{description}</span>
        </span>
      )}
      <span className="absolute right-2 inline-flex size-4 items-center justify-center">
        <RadixSelect.ItemIndicator>
          <Check className="size-3" aria-hidden="true" />
        </RadixSelect.ItemIndicator>
      </span>
    </RadixSelect.Item>
  );
}

const Select = RadixSelect.Root;
const SelectValue = RadixSelect.Value;
const SelectGroup = RadixSelect.Group;

export { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue };
