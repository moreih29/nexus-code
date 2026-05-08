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
        className={cn(
          "shrink-0",
          options.isCaseSensitive && "bg-frosted-veil-strong text-foreground",
        )}
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
        className={cn("shrink-0", options.isWordMatch && "bg-frosted-veil-strong text-foreground")}
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
        className={cn("shrink-0", options.isRegExp && "bg-frosted-veil-strong text-foreground")}
        onClick={() => onToggle("isRegExp")}
      >
        <Regex aria-hidden="true" />
      </Button>
    </>
  );
}
