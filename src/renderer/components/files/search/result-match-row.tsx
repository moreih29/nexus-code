/**
 * Single match row inside an expanded file group.
 * Shows: line number + preview text with the match span highlighted.
 * Indent: 20px from left.
 */

import type { SearchRange } from "../../../../shared/types/search";
import { ROW_HEIGHT_PX } from "../file-tree/metrics";

const MATCH_INDENT_PX = 20;

interface SearchResultMatchRowProps {
  range: SearchRange;
  preview: string;
  onClick: () => void;
}

export function SearchResultMatchRow({ range, preview, onClick }: SearchResultMatchRowProps) {
  const { line, startCol, endCol } = range;
  const before = preview.slice(0, startCol);
  const match = preview.slice(startCol, endCol);
  const after = preview.slice(endCol);

  return (
    <button
      type="button"
      onClick={onClick}
      style={{ height: ROW_HEIGHT_PX, paddingLeft: MATCH_INDENT_PX }}
      className="flex items-center w-full pr-2 gap-1.5 text-left cursor-pointer select-none hover:bg-frosted-veil-strong focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-mist-border focus-visible:ring-inset"
    >
      <span className="shrink-0 font-mono text-app-ui-sm text-muted-foreground w-8 text-right">
        {line + 1}
      </span>
      <span className="font-mono text-app-ui-sm truncate min-w-0">
        {before}
        <mark className="bg-frosted-veil-strong text-foreground not-italic">{match}</mark>
        {after}
      </span>
    </button>
  );
}
