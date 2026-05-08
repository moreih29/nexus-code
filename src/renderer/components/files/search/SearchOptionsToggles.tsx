/**
 * Three toggle buttons: CaseSensitive, WholeWord, Regex.
 * Rendered inline-right inside the search input area.
 */

import { CaseSensitive, Regex, WholeWord } from "lucide-react";
import { cn } from "@/utils/cn";
import type { SearchOptions } from "../../../state/stores/search";
import { Button } from "../../ui/button";

interface SearchOptionsTogglesProps {
  options: SearchOptions;
  onToggle: (
    key: keyof Pick<SearchOptions, "isCaseSensitive" | "isWordMatch" | "isRegExp">,
  ) => void;
}

// ON-state styling: an inset ring + foreground text + frosted background.
// The ring is what distinguishes "pressed" from "hover" — the ghost
// variant's hover state shares the same bg-frosted-veil-strong, so a bg
// change alone would let pressed and hover look identical.
const TOGGLE_ON_CLASS =
  "bg-frosted-veil-strong text-foreground ring-1 ring-inset ring-mist-border-focus";

export function SearchOptionsToggles({ options, onToggle }: SearchOptionsTogglesProps) {
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
    </>
  );
}
