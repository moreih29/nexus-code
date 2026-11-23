import { ChevronDown, ChevronUp } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";

interface NumberInputProps {
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  step?: number;
  ariaLabel?: string;
  suffix?: string;
  id?: string;
  className?: string;
}

export function parseNumberInputText(
  raw: string,
  { min, max, step }: { min: number; max: number; step: number },
): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  const snapped = min + Math.round((parsed - min) / step) * step;
  return Math.min(max, Math.max(min, snapped));
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
  const [text, setText] = useState<string>(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = useCallback(
    (raw: string) => {
      const next = parseNumberInputText(raw, { min, max, step });
      if (next === null) {
        setText(String(value));
        return;
      }
      setText(String(next));
      if (next !== value) onChange(next);
    },
    [max, min, onChange, step, value],
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
