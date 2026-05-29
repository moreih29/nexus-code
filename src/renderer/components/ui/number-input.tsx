// src/renderer/components/ui/number-input.tsx — Token-sealed numeric stepper.
//
// Single-line numeric input with ▲/▼ stepper buttons. Used in Settings for
// font size (where a slider hid the value behind discrete tick marks) and
// any future field whose value is "type the number you want, clamp to range".
//
// Design seal: control-radius border, no shadow, focus ring via --ring,
// stepper buttons use ghost hover overlay. Clamped to [min, max] on commit.
// Up/Down arrow keys step by `step`; Shift+Arrow steps by `step * 10`.

import { ChevronDown, ChevronUp } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";

interface NumberInputProps {
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  /** Stepper increment (default 1). */
  step?: number;
  /** Accessible label. */
  ariaLabel?: string;
  /** Suffix shown to the right of the number (e.g. "px"). */
  suffix?: string;
  /** Forwarded id (for <label htmlFor>). */
  id?: string;
  className?: string;
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  ariaLabel,
  suffix,
  id,
  className,
}: NumberInputProps) {
  const { t } = useTranslation();
  // Local text state lets the user type intermediate strings ("" while
  // clearing, "1" mid-typing of "16") without the parent receiving invalid
  // numbers. Committed on blur / Enter / stepper click.
  const [text, setText] = useState<string>(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = useCallback(
    (raw: string) => {
      const parsed = Number(raw);
      if (Number.isNaN(parsed)) {
        setText(String(value));
        return;
      }
      const clamped = Math.min(max, Math.max(min, parsed));
      setText(String(clamped));
      if (clamped !== value) onChange(clamped);
    },
    [max, min, onChange, value],
  );

  const stepBy = useCallback(
    (delta: number) => {
      const next = Math.min(max, Math.max(min, value + delta));
      if (next !== value) onChange(next);
    },
    [max, min, onChange, value],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        stepBy(e.shiftKey ? step * 10 : step);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        stepBy(e.shiftKey ? -step * 10 : -step);
      } else if (e.key === "Enter") {
        e.preventDefault();
        commit(text);
      }
    },
    [commit, step, stepBy, text],
  );

  return (
    <div
      className={cn(
        "inline-flex items-stretch rounded-(--radius-control) border border-border bg-background",
        "focus-within:ring-1 focus-within:ring-ring",
        className,
      )}
    >
      <input
        id={id}
        type="text"
        inputMode="numeric"
        aria-label={ariaLabel}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(text)}
        onKeyDown={handleKeyDown}
        className={cn(
          "w-14 bg-transparent px-2 py-1 text-app-body text-foreground outline-none tabular-nums text-right",
        )}
      />
      {suffix && (
        <span className="flex items-center pr-1 text-app-ui-sm text-muted-foreground select-none">
          {suffix}
        </span>
      )}
      <div className="flex flex-col border-l border-border">
        <button
          type="button"
          aria-label={t("action.increase")}
          tabIndex={-1}
          onClick={() => stepBy(step)}
          disabled={value >= max}
          className={cn(
            "flex h-1/2 items-center justify-center px-1.5",
            "hover:bg-[var(--state-hover-bg)] disabled:opacity-40 disabled:pointer-events-none",
            "border-b border-border",
          )}
        >
          <ChevronUp className="size-3 text-muted-foreground" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={t("action.decrease")}
          tabIndex={-1}
          onClick={() => stepBy(-step)}
          disabled={value <= min}
          className={cn(
            "flex h-1/2 items-center justify-center px-1.5",
            "hover:bg-[var(--state-hover-bg)] disabled:opacity-40 disabled:pointer-events-none",
          )}
        >
          <ChevronDown className="size-3 text-muted-foreground" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
