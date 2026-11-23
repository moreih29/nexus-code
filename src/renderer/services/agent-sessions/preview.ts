import { baseName } from "../chat/links";

const FENCE = /```[^\s`]*/g;
const HEADING = /(^|\s)#{1,6}(?=\s)/g;

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

export function oneLineMarkdown(text: string): string {
  return text
    .replace(FENCE, " ")
    .replace(HEADING, "$1")
    .replace(/^\s*(?:[-*+]|\d+[.)]|>)\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}
