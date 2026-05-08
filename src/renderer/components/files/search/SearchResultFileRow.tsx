/**
 * File group header row in the flat search results list.
 * Shows: chevron + file icon + truncated relPath + match-count badge.
 */

import { ChevronDown, ChevronRight } from "lucide-react";
import { getFileIcon } from "../file-tree/file-tree-icons";
import { ROW_HEIGHT_PX } from "../file-tree/file-tree-metrics";

interface SearchResultFileRowProps {
  relPath: string;
  matchCount: number;
  expanded: boolean;
  onToggle: () => void;
}

export function SearchResultFileRow({
  relPath,
  matchCount,
  expanded,
  onToggle,
}: SearchResultFileRowProps) {
  const fileName = relPath.includes("/") ? relPath.slice(relPath.lastIndexOf("/") + 1) : relPath;
  const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  const FileIcon = getFileIcon(fileName);
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <button
      type="button"
      onClick={onToggle}
      title={relPath}
      style={{ height: ROW_HEIGHT_PX }}
      className="flex items-center w-full px-2 gap-1 text-left cursor-pointer select-none hover:bg-frosted-veil-strong focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-mist-border focus-visible:ring-inset"
    >
      <Chevron className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <FileIcon
        className="size-3.5 shrink-0 text-muted-foreground"
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <span className="truncate min-w-0 text-app-body flex-1">
        {fileName}
        {dir && <span className="ml-1.5 text-muted-foreground text-app-ui-sm">{dir}</span>}
      </span>
      <span className="shrink-0 text-app-ui-sm text-muted-foreground bg-frosted-veil-strong rounded px-1">
        {matchCount}
      </span>
    </button>
  );
}
