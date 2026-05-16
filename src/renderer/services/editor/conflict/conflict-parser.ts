/**
 * Conflict-marker parser for in-app merge conflict resolution.
 *
 * Git writes three (or four with diff3) marker families into the working-tree
 * file when a merge, rebase, or cherry-pick produces a conflict:
 *
 *   <<<<<<< ours / HEAD / current branch label
 *   ... current (ours) content ...
 *   ||||||| base (diff3 only — enabled with merge.conflictstyle=diff3)
 *   ... common ancestor content ...
 *   =======
 *   ... incoming (theirs) content ...
 *   >>>>>>> their branch label
 *
 * A file may contain multiple non-overlapping conflict blocks. This module
 * parses the full text into a list of `ConflictBlock` descriptors that carry
 * precise 1-based line ranges for every section, ready for use by Monaco
 * CodeLens and decoration providers.
 */

/**
 * A fully-parsed single conflict block within a file.
 *
 * All line numbers are 1-based (Monaco convention). A "section" spans from
 * its first line to the last line before the next marker. Marker lines
 * themselves are included in the outer block range and listed separately so
 * consumers can style / hide them independently.
 *
 * The `base` section is only present when the file was written with the
 * diff3 conflict style (`merge.conflictstyle=diff3` / `zdiff3`). When
 * absent, `base` is `null`.
 */
export interface ConflictSection {
  /** First line of this section (inclusive, 1-based). */
  startLine: number;
  /** Last line of this section (inclusive, 1-based). */
  endLine: number;
}

export interface ConflictBlock {
  /** Zero-based index within the file's block list. */
  index: number;
  /**
   * Full block span including all markers and content sections,
   * from the `<<<<<<<` line to the `>>>>>>>` line (inclusive).
   */
  blockRange: ConflictSection;
  /** The `<<<<<<<` marker line. */
  currentMarkerLine: number;
  /** Content section attributed to the current/ours side (between `<<<<<<<` and `|||||||` or `=======`). */
  current: ConflictSection;
  /**
   * Content section for the common ancestor (between `|||||||` and `=======`).
   * Null when the diff3 base marker was not found in this block.
   */
  base: ConflictSection | null;
  /** The `|||||||` marker line, or null when absent. */
  baseMarkerLine: number | null;
  /** The `=======` separator marker line. */
  separatorLine: number;
  /** Content section attributed to the incoming/theirs side (between `=======` and `>>>>>>>`). */
  incoming: ConflictSection;
  /** The `>>>>>>>` marker line. */
  incomingMarkerLine: number;
}

/** Regex patterns for each marker type. Each matches anywhere on the line. */
const CURRENT_RE = /^<{7}( |$)/;
const BASE_RE = /^\|{7}( |$)/;
const SEPARATOR_RE = /^={7}$/;
const INCOMING_RE = /^>{7}( |$)/;

/**
 * Parses the full text of a file and returns the list of conflict blocks,
 * in order from top to bottom. Returns an empty array when no conflict
 * markers are found or when the markers appear malformed.
 *
 * The parser is intentionally lenient: an incomplete/nested block is skipped
 * rather than throwing, so a broken file does not block the rest from rendering.
 */
export function parseConflictBlocks(text: string): ConflictBlock[] {
  const lines = text.split("\n");
  const blocks: ConflictBlock[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line || !CURRENT_RE.test(line)) {
      i++;
      continue;
    }

    // Found a `<<<<<<<` marker — try to parse a complete block from here.
    const block = parseBlock(lines, i);
    if (block !== null) {
      blocks.push({ ...block, index: blocks.length });
      // Resume scanning at the line after `>>>>>>>`: the marker's 1-based line
      // number equals the 0-based index of the line that follows it.
      i = block.incomingMarkerLine;
    } else {
      i++;
    }
  }

  return blocks;
}

/**
 * Attempts to parse one complete conflict block starting at `startIdx`
 * (0-based index into `lines`). Returns a partial block (without `index`)
 * on success, or null if the block is incomplete/malformed.
 */
function parseBlock(
  lines: readonly string[],
  startIdx: number,
): Omit<ConflictBlock, "index"> | null {
  const currentMarkerLine = startIdx + 1; // convert to 1-based

  let baseMarkerLine: number | null = null;
  let separatorLine: number | null = null;
  let incomingMarkerLine: number | null = null;

  // Scan forward for the other markers within this block.
  for (let j = startIdx + 1; j < lines.length; j++) {
    const l = lines[j];
    if (!l) continue;

    if (CURRENT_RE.test(l)) {
      // Nested conflict start — the outer block is malformed; bail.
      return null;
    }

    if (BASE_RE.test(l) && baseMarkerLine === null && separatorLine === null) {
      baseMarkerLine = j + 1; // 1-based
      continue;
    }

    if (SEPARATOR_RE.test(l) && separatorLine === null) {
      separatorLine = j + 1; // 1-based
      continue;
    }

    if (INCOMING_RE.test(l) && separatorLine !== null) {
      incomingMarkerLine = j + 1; // 1-based
      break;
    }
  }

  if (separatorLine === null || incomingMarkerLine === null) {
    // Incomplete block — skip it.
    return null;
  }

  // Compute section spans. Content lines immediately follow/precede markers.
  const current: ConflictSection = {
    startLine: currentMarkerLine + 1,
    endLine: (baseMarkerLine ?? separatorLine) - 1,
  };

  const base: ConflictSection | null =
    baseMarkerLine !== null
      ? { startLine: baseMarkerLine + 1, endLine: separatorLine - 1 }
      : null;

  const incoming: ConflictSection = {
    startLine: separatorLine + 1,
    endLine: incomingMarkerLine - 1,
  };

  return {
    blockRange: { startLine: currentMarkerLine, endLine: incomingMarkerLine },
    currentMarkerLine,
    current,
    base,
    baseMarkerLine,
    separatorLine,
    incoming,
    incomingMarkerLine,
  };
}

/**
 * Returns true when the given text contains at least one recognisable
 * conflict-marker opening line (`<<<<<<<`). Used as a fast pre-check before
 * running the full parser.
 */
export function hasConflictMarkers(text: string): boolean {
  return CURRENT_RE.test(text) || text.includes("\n<<<<<<<");
}

// ---------------------------------------------------------------------------
// Accept-action helpers
//
// Each function takes the full file text and a single ConflictBlock and
// returns the new file content after applying the requested resolution.
// The entire block — markers and all — is replaced with the chosen lines.
// ---------------------------------------------------------------------------

/**
 * Returns the file text after accepting the "current" (ours / HEAD) side of
 * one conflict block. The block's markers and the incoming section are removed;
 * only the lines between `<<<<<<<` and `|||||||`/`=======` are kept.
 */
export function acceptCurrent(text: string, block: ConflictBlock): string {
  return replaceBlock(text, block, linesForSection(text, block.current));
}

/**
 * Returns the file text after accepting the "incoming" (theirs) side of one
 * conflict block. The block's markers and the current section are removed;
 * only the lines between `=======` and `>>>>>>>` are kept.
 */
export function acceptIncoming(text: string, block: ConflictBlock): string {
  return replaceBlock(text, block, linesForSection(text, block.incoming));
}

/**
 * Returns the file text after accepting both sides of one conflict block
 * (current followed by incoming). Markers are removed; base is discarded.
 */
export function acceptBoth(text: string, block: ConflictBlock): string {
  const currentLines = linesForSection(text, block.current);
  const incomingLines = linesForSection(text, block.incoming);
  return replaceBlock(text, block, [...currentLines, ...incomingLines]);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Splits the file text into lines (preserving the exact split used by the
 * parser) and returns the subset that belong to `section`.
 */
function linesForSection(text: string, section: ConflictSection): string[] {
  const lines = text.split("\n");
  // Section is 1-based; array is 0-based.
  return lines.slice(section.startLine - 1, section.endLine);
}

/**
 * Replaces the entire block (from its `<<<<<<<` line through its `>>>>>>>`
 * line) in `text` with `replacementLines`, returning the resulting string.
 *
 * Uses the same line split/join as the parser so line-ending behaviour is
 * consistent across calls.
 */
function replaceBlock(
  text: string,
  block: ConflictBlock,
  replacementLines: string[],
): string {
  const lines = text.split("\n");
  const blockStart = block.blockRange.startLine - 1; // 0-based
  const blockEnd = block.blockRange.endLine - 1; // 0-based (inclusive)
  const before = lines.slice(0, blockStart);
  const after = lines.slice(blockEnd + 1);
  return [...before, ...replacementLines, ...after].join("\n");
}
