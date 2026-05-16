/**
 * Search input option toggles: CaseSensitive, WholeWord, Regex, then a 1px
 * mist-border divider, then a ViewModeToggle (list ↔ tree + compact folders).
 */

import { CaseSensitive, Regex, WholeWord } from "lucide-react";
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
  /** Current compact-folders setting. */
  compactFolders: boolean;
  /** Called when the user toggles compact folders. */
  onCompactChange: (next: boolean) => void;
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
  compactFolders,
  onCompactChange,
  viewModeDisabled = false,
}: SearchOptionsTogglesProps) {
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Match case"
        aria-pressed={options.isCaseSensitive}
        title="Match case (Alt+C)"
        className={cn("shrink-0", options.isCaseSensitive && TOGGLE_ON_CLASS)}
        onClick={() => onToggle("isCaseSensitive")}
      >
        <CaseSensitive aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Match whole word"
        aria-pressed={options.isWordMatch}
        title="Match whole word (Alt+W)"
        className={cn("shrink-0", options.isWordMatch && TOGGLE_ON_CLASS)}
        onClick={() => onToggle("isWordMatch")}
      >
        <WholeWord aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Use regular expression"
        aria-pressed={options.isRegExp}
        title="Use regular expression (Alt+R)"
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
        compactFolders={compactFolders}
        onCompactChange={onCompactChange}
        disabled={viewModeDisabled}
      />
    </>
  );
}
