/**
 * An agent's answer, written in Markdown, where the agent list shows it in
 * short: as plain words in a row of its list, and on one line in its
 * detail, where a terminal's agent tells it with its line breaks gone.
 * Pure.
 */

import { baseName } from "../chat/links";

/** A code fence, with the language that may follow it. */
const FENCE = /```[^\s`]*/g;
/** A heading's hashes, where a line once started. */
const HEADING = /(^|\s)#{1,6}(?=\s)/g;

/**
 * The answer as plain words on one line: no hashes, list marks, quotes,
 * fences, stars or backticks; a link as its words, an image as its words or
 * else its file's name.
 */
export function plainPreview(text: string): string {
  return text
    .replace(FENCE, " ")
    .replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]*)>?[^)]*\)/g, (_, alt: string, src: string) =>
      alt.trim() ? alt : baseName(src),
    )
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(HEADING, "$1")
    .replace(/(^|\n)[ \t]*(?:[-*+]|\d+[.)])[ \t]+/g, "$1")
    .replace(/(^|\n)[ \t]*>[ \t]?/g, "$1")
    .replace(/(\*\*|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * An answer whose line breaks are gone, made to read as one line of
 * Markdown: what would take the whole of it (a heading, a list or a quote
 * at its start) and the fences, whose code is left as words, are taken
 * out; bold, code, links and images stay.
 */
export function oneLineMarkdown(text: string): string {
  return text
    .replace(FENCE, " ")
    .replace(HEADING, "$1")
    .replace(/^\s*(?:[-*+]|\d+[.)]|>)\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}
