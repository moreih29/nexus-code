/**
 * Sticky History search input. Debouncing is owned by HistoryPanel so tests
 * can exercise the input as a pure controlled component.
 */
import { useTranslation } from "react-i18next";

interface HistorySearchProps {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onClear: () => void;
}

/** Renders the commit search box used for SHA-prefix and message grep search. */
export function HistorySearch({ value, disabled = false, onChange, onClear }: HistorySearchProps) {
  const { t } = useTranslation("files");
  return (
    <div className="sticky top-0 z-10 border-b border-border bg-background px-2 py-2">
      <label className="sr-only" htmlFor="git-history-search">
        {t("git.history.search.label")}
      </label>
      <div className="flex items-center gap-1">
        <input
          id="git-history-search"
          type="search"
          value={value}
          disabled={disabled}
          placeholder={t("git.history.search.placeholder")}
          className="min-w-0 flex-1 rounded-sm border border-border bg-background px-2 py-1 text-app-ui-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
          onChange={(event) => onChange(event.target.value)}
        />
        {value.trim().length > 0 ? (
          <button
            type="button"
            disabled={disabled}
            className="rounded px-2 py-1 text-app-ui-sm text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
            onClick={onClear}
          >
            {t("git.history.search.clear")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
