/**
 * Search input option toggles: CaseSensitive, WholeWord, Regex, then a 1px
 * mist-border divider, then a ViewModeToggle (list ↔ tree).
 */

import { CaseSensitive, Regex, WholeWord } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { ViewMode } from "../../../../shared/types/panel";
import type { SearchOptions } from "../../../state/stores/search";
import { Button } from "../../ui/button";
import { ViewModeToggle } from "../view-mode-toggle";

interface SearchOptionsTogglesProps {
  options: SearchOptions;
  onToggle: (
    key: keyof Pick<SearchOptions, "isCaseSensitive" | "isWordMatch" | "isRegExp">,
  ) => void;
  /** Current view mode for the view-mode toggle. */
  viewMode: ViewMode;
  /** Called when the user switches list ↔ tree. */
  onViewModeChange: (next: ViewMode) => void;
  /** Disable the view-mode toggle when there are no results to show. */
  viewModeDisabled?: boolean;
}

// ON-state styling: an inset ring + foreground text + active overlay background.
// The ring is what distinguishes "pressed" from "hover" — the ghost
// variant's hover state shares the same state.hover.bg overlay, so a bg
// change alone would let pressed and hover look identical.
const TOGGLE_ON_CLASS =
  "bg-[var(--state-active-bg)] text-foreground ring-1 ring-inset ring-ring";

export function SearchOptionsToggles({
  options,
  onToggle,
  viewMode,
  onViewModeChange,
  viewModeDisabled = false,
}: SearchOptionsTogglesProps) {
  const { t } = useTranslation("files");
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t("search.options.matchCase")}
        aria-pressed={options.isCaseSensitive}
        title={t("search.options.matchCaseTooltip")}
        className={cn("shrink-0", options.isCaseSensitive && TOGGLE_ON_CLASS)}
        onClick={() => onToggle("isCaseSensitive")}
      >
        <CaseSensitive aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t("search.options.matchWholeWord")}
        aria-pressed={options.isWordMatch}
        title={t("search.options.matchWholeWordTooltip")}
        className={cn("shrink-0", options.isWordMatch && TOGGLE_ON_CLASS)}
        onClick={() => onToggle("isWordMatch")}
      >
        <WholeWord aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t("search.options.useRegex")}
        aria-pressed={options.isRegExp}
        title={t("search.options.useRegexTooltip")}
        className={cn("shrink-0", options.isRegExp && TOGGLE_ON_CLASS)}
        onClick={() => onToggle("isRegExp")}
      >
        <Regex aria-hidden="true" />
      </Button>
      {/* 1px mist-border divider separating search-option toggles from view-mode toggle */}
      <span className="w-px self-stretch bg-border mx-0.5 shrink-0" aria-hidden="true" />
      <ViewModeToggle
        viewMode={viewMode}
        onViewModeChange={onViewModeChange}
        disabled={viewModeDisabled}
      />
    </>
  );
}
