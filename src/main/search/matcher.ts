/**
 * Pure text-search matcher — no fs, no IPC.
 * All functions here are side-effect-free so they can be unit-tested without
 * an Electron runtime.
 */
import { BINARY_DETECTION_BYTES } from "../../shared/fs-defaults";
import type { SearchRange, TextSearchQuery } from "../../shared/types/search";
import { isBinaryProbe } from "../filesystem/binary-detect";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class InvalidSearchPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSearchPatternError";
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Escape all regex metacharacters so a literal string can be used as a pattern. */
function escapeRegExpCharacters(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// compileSearchRegExp
// ---------------------------------------------------------------------------

export function compileSearchRegExp(query: TextSearchQuery): RegExp {
  const src = query.isRegExp ? query.pattern : escapeRegExpCharacters(query.pattern);

  let flags = "gu";
  if (!query.isCaseSensitive) {
    flags += "i";
  }

  if (query.isWordMatch) {
    // Mirror VSCode strings.ts:202-229: suppress \b wrapping only when the
    // source already begins with \B or ends with \B (the caller explicitly
    // opted out of word-boundary semantics on that side).
    const needsLeading = !src.startsWith("\\B");
    const needsTrailing = !src.endsWith("\\B");
    const wrapped = `${needsLeading ? "\\b" : ""}${src}${needsTrailing ? "\\b" : ""}`;

    try {
      return new RegExp(wrapped, flags);
    } catch (e) {
      throw new InvalidSearchPatternError(
        `Invalid search pattern "${query.pattern}": ${(e as Error).message}`,
      );
    }
  }

  try {
    return new RegExp(src, flags);
  } catch (e) {
    throw new InvalidSearchPatternError(
      `Invalid search pattern "${query.pattern}": ${(e as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// MatcherMatch
// ---------------------------------------------------------------------------

export interface MatcherMatch {
  range: SearchRange;
  preview: string;
}

// ---------------------------------------------------------------------------
// findMatchesInBuffer
// ---------------------------------------------------------------------------

const UTF8_BOM = "﻿";

export function findMatchesInBuffer(
  buf: Buffer,
  regex: RegExp,
  perFileCap: number,
): MatcherMatch[] {
  // Defense-in-depth: skip binary files (walker also probes, but be safe).
  if (isBinaryProbe(buf.subarray(0, BINARY_DETECTION_BYTES))) {
    return [];
  }

  let text = buf.toString("utf8");
  if (text.startsWith(UTF8_BOM)) {
    text = text.slice(1);
  }

  const lines = text.split(/\r\n|\n|\r/);
  const matches: MatcherMatch[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    regex.lastIndex = 0;

    for (;;) {
      const m = regex.exec(line);
      if (m === null) break;
      // Guard against zero-width matches causing infinite loops.
      if (m.index === regex.lastIndex) {
        regex.lastIndex++;
      }
      matches.push({
        range: {
          line: lineIndex,
          startCol: m.index,
          endCol: m.index + m[0].length,
        },
        preview: line,
      });
      if (matches.length >= perFileCap) {
        return matches;
      }
    }
  }

  return matches;
}
