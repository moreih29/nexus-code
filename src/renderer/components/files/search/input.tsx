/**
 * Search input row: <input> + clear button + option toggles.
 * Exposes an optional inline regex-error message below the input.
 */

import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { ViewMode } from "../../../../shared/types/panel";
import type { SearchOptions } from "../../../state/stores/search";
import { Button } from "../../ui/button";
import { SearchOptionsToggles } from "./options-toggles";

interface SearchInputProps {
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  options: SearchOptions;
  regexError: string | null;
  onChange: (value: string) => void;
  onEnter: () => void;
  onEsc: () => void;
  onToggleOption: (
    key: keyof Pick<SearchOptions, "isCaseSensitive" | "isWordMatch" | "isRegExp">,
  ) => void;
  /**
   * Called when the user presses ↓ in the search input. The parent should
   * blur the input and move focus to the first row of the results list.
   */
  onArrowDown?: () => void;
  /** View-mode toggle props forwarded to SearchOptionsToggles. */
  viewMode: ViewMode;
  onViewModeChange: (next: ViewMode) => void;
  viewModeDisabled?: boolean;
}

export function SearchInput({
  inputRef,
  value,
  options,
  regexError,
  onChange,
  onEnter,
  onEsc,
  onToggleOption,
  onArrowDown,
  viewMode,
  onViewModeChange,
  viewModeDisabled,
}: SearchInputProps) {
  const { t } = useTranslation("files");
  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      onEnter();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onEsc();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      onArrowDown?.();
    }
  }

  return (
    <div className="px-2 pt-2 pb-1 flex flex-col gap-1">
      <div
        className={cn(
          "flex items-center gap-0.5 rounded border bg-background transition-colors",
          regexError
            ? "border-destructive focus-within:border-destructive"
            : "border-border focus-within:border-ring",
        )}
      >
        <input
          ref={inputRef}
          type="search"
          placeholder={t("search.placeholder")}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          className="flex-1 min-w-0 bg-transparent px-2 py-1 text-app-body outline-none placeholder:text-muted-foreground"
          aria-label={t("search.ariaLabel")}
          spellCheck={false}
        />
        {value.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("search.clearSearch")}
            className="shrink-0"
            onClick={() => onChange("")}
          >
            <X aria-hidden="true" />
          </Button>
        )}
        <div className="flex items-center gap-0.5 pr-0.5">
          <SearchOptionsToggles
            options={options}
            onToggle={onToggleOption}
            viewMode={viewMode}
            onViewModeChange={onViewModeChange}
            viewModeDisabled={viewModeDisabled}
          />
        </div>
      </div>
      {regexError && (
        <p className="text-destructive text-app-ui-sm px-1" role="alert">
          {t("search.invalidRegex", { error: regexError })}
        </p>
      )}
    </div>
  );
}
