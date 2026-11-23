import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { classifyUrl } from "@/services/browser/url-classifier";
import { cn } from "@/utils/cn";
import { isImeComposing } from "@/utils/ime";

interface UrlBarProps {
  currentUrl: string;
  isLoading: boolean;
  onNavigate: (url: string) => void;
  autoFocus?: boolean;
  focusToken?: number;
  className?: string;
}

export function UrlBar({
  currentUrl,
  isLoading,
  onNavigate,
  autoFocus = false,
  focusToken = 0,
  className,
}: UrlBarProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [localValue, setLocalValue] = useState(currentUrl);
  const [isFocused, setIsFocused] = useState(false);
  const [blockedError, setBlockedError] = useState<string | null>(null);

  useEffect(() => {
    if (!isFocused) {
      setLocalValue(currentUrl);
    }
  }, [currentUrl, isFocused]);

  useEffect(() => {
    if (focusToken === 0) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [focusToken]);

  function handleFocus() {
    setIsFocused(true);
    setBlockedError(null);
    inputRef.current?.select();
  }

  function handleBlur() {
    setIsFocused(false);
    setLocalValue(currentUrl);
    setBlockedError(null);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setLocalValue(e.target.value);
    setBlockedError(null);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (isImeComposing(e)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      const result = classifyUrl(localValue);
      if (result.kind === "blocked") {
        setBlockedError(result.error ?? t("browser.url_blocked_default"));
        return;
      }
      setBlockedError(null);
      onNavigate(result.url);
      inputRef.current?.blur();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setLocalValue(currentUrl);
      setBlockedError(null);
      inputRef.current?.blur();
    }
  }

  return (
    <div className={cn("flex flex-col flex-1 min-w-0", className)}>
      <div
        className={cn(
          "flex items-center flex-1 rounded-(--radius-control)",
          "bg-[var(--surface-island-bg,hsl(var(--background)))]",
          "border border-[var(--surface-island-border)]",
          "px-2 h-7",
          "transition-colors",
          isFocused && "ring-[3px] ring-ring/50 border-ring",
          isLoading &&
            !isFocused &&
            "border-[var(--state-loading-indicator,var(--surface-island-border))]",
          blockedError && "border-destructive ring-destructive/20 ring-[3px]",
        )}
      >
        <input
          ref={inputRef}
          type="text"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          aria-label={t("browser.url_aria")}
          placeholder={t("browser.url_placeholder")}
          value={localValue}
          // biome-ignore lint/a11y/noAutofocus: new browser tabs auto-focus the URL bar so the user can type immediately
          autoFocus={autoFocus}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          className={cn(
            "flex-1 min-w-0 bg-transparent outline-none",
            "text-app-ui-sm text-foreground placeholder:text-muted-foreground",
            "selection:bg-[var(--selection-bg,rgba(99,179,237,0.3))]",
          )}
        />
      </div>
      {blockedError && (
        <p className="mt-0.5 text-app-label text-destructive px-1" role="alert">
          {blockedError}
        </p>
      )}
    </div>
  );
}
