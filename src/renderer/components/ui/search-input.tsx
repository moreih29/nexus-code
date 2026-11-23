import { Search, X } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, Ref } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { isImeComposing } from "@/utils/ime";

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  inputRef?: Ref<HTMLInputElement>;
  "data-testid"?: string;
}

export function SearchInput({
  value,
  onChange,
  label,
  placeholder,
  disabled = false,
  id,
  className,
  onKeyDown,
  inputRef,
  "data-testid": testId,
}: SearchInputProps) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "flex h-7 min-w-0 items-center gap-1.5 rounded-(--radius-control) border border-border bg-background px-2",
        "focus-within:border-ring",
        disabled && "opacity-50",
        className,
      )}
    >
      <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        id={id}
        type="search"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        ref={inputRef}
        onKeyDown={(event) => {
          if (isImeComposing(event)) return;
          if (event.key === "Escape" && value !== "") {
            event.preventDefault();
            onChange("");
            return;
          }
          onKeyDown?.(event);
        }}
        aria-label={label}
        placeholder={placeholder ?? label}
        data-escape-clears=""
        data-testid={testId}
        className="min-w-0 flex-1 bg-transparent text-app-ui-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
      {value !== "" && !disabled && (
        <button
          type="button"
          aria-label={t("action.clear_search")}
          title={t("action.clear_search")}
          onClick={() => onChange("")}
          className="inline-flex shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          <X aria-hidden className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function escapeClearsSearch(event: KeyboardEvent): void {
  const focused = document.activeElement;
  if (
    focused instanceof HTMLInputElement &&
    focused.dataset.escapeClears !== undefined &&
    focused.value !== ""
  ) {
    event.preventDefault();
  }
}
