import type { ReactNode } from "react";
import { cn } from "@/utils/cn";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  id?: string;
  disabled?: boolean;
  disabledReason?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  id,
  disabled,
  disabledReason,
}: SegmentedControlProps<T>) {
  const groupId = id ?? `segmented-${label.toLowerCase().replace(/\s+/g, "-")}`;

  return (
    <fieldset
      aria-label={label}
      id={groupId}
      disabled={disabled}
      title={disabled ? disabledReason : undefined}
      className={cn(
        "inline-flex w-fit shrink-0 rounded-(--radius-raised) border border-border bg-muted p-0.5 gap-0.5",
        disabled && "opacity-60",
      )}
    >
      {options.map((opt) => {
        const isSelected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={isSelected}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 whitespace-nowrap",
              "rounded-(--radius-control) px-2 py-0.5 text-app-ui-sm font-sans transition-colors",
              isSelected
                ? "bg-[var(--state-selected-bg)] text-[var(--state-selected-fg)]"
                : "bg-transparent text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground",
              disabled && "cursor-not-allowed",
            )}
          >
            {opt.icon && (
              <span className="inline-flex shrink-0 items-center" aria-hidden="true">
                {opt.icon}
              </span>
            )}
            {opt.label}
          </button>
        );
      })}
    </fieldset>
  );
}
