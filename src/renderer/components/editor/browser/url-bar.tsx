/**
 * UrlBar — controlled URL input for the browser tab toolbar.
 *
 * BEHAVIOR
 * --------
 * - Displays the current URL from BrowserRuntimeStore (or empty string for a
 *   new tab). Local input state tracks edits before submission.
 * - On focus: selects all text so the user can replace the current URL instantly.
 * - On Enter: classifies the input with `classifyUrl` and calls `onNavigate` or
 *   shows an inline blocked-scheme error.
 * - On Escape: restores the store's currentUrl and blurs.
 * - URL display syncs to runtime store whenever the input is NOT focused.
 *
 * The component is intentionally stateless with respect to navigation history —
 * it only reads from the runtime store and fires `onNavigate` upward.
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "@/utils/cn";
import { classifyUrl } from "@/services/browser/url-classifier";

interface UrlBarProps {
  /** Current URL from the runtime store (kept in sync when not focused). */
  currentUrl: string;
  /** Whether the browser is in a loading state (subtle visual indicator). */
  isLoading: boolean;
  /** Called with the resolved URL when the user submits a valid navigation. */
  onNavigate: (url: string) => void;
  /** Whether this input should be auto-focused on mount (new/empty tabs). */
  autoFocus?: boolean;
  /** Imperative focus request counter — increments trigger focus+select. */
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
  const inputRef = useRef<HTMLInputElement>(null);
  const [localValue, setLocalValue] = useState(currentUrl);
  const [isFocused, setIsFocused] = useState(false);
  const [blockedError, setBlockedError] = useState<string | null>(null);

  // Sync store URL → local value whenever NOT focused.
  useEffect(() => {
    if (!isFocused) {
      setLocalValue(currentUrl);
    }
  }, [currentUrl, isFocused]);

  // Respond to external focus requests (e.g., ⌘L shortcut).
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
    // Select all on focus so the user can type a replacement immediately.
    inputRef.current?.select();
  }

  function handleBlur() {
    setIsFocused(false);
    // Restore to the committed URL on blur without explicit submission.
    setLocalValue(currentUrl);
    setBlockedError(null);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setLocalValue(e.target.value);
    setBlockedError(null);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      const result = classifyUrl(localValue);
      if (result.kind === "blocked") {
        setBlockedError(result.error ?? "This URL scheme is not allowed.");
        return;
      }
      setBlockedError(null);
      onNavigate(result.url);
      inputRef.current?.blur();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      // Restore to committed URL and relinquish focus.
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
          isLoading && !isFocused && "border-[var(--state-loading-indicator,var(--surface-island-border))]",
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
          aria-label="URL or search"
          placeholder="Enter URL or search…"
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
