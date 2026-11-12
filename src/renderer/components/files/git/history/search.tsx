/**
 * Sticky History search input. Debouncing is owned by HistoryPanel so tests
 * can exercise the input as a pure controlled component.
 */
import { useTranslation } from "react-i18next";
import { SearchInput } from "../../../ui/search-input";

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
      <SearchInput
        id="git-history-search"
        value={value}
        disabled={disabled}
        onChange={(next) => (next === "" ? onClear() : onChange(next))}
        label={t("git.history.search.label")}
        placeholder={t("git.history.search.placeholder")}
      />
    </div>
  );
}
