import { shownNoteText } from "../../../shared/notes/line-report";

// A chat tab's title: the first sentence of its first message, kept short,
// until the agent names the conversation. A path in it reads as its last
// part, so a brief's file name is what the title shows.

/** Longest title a tab keeps; the tab strip shows less and the rest on hover. */
export const TITLE_CHARS = 60;

/** The end of a sentence: stops followed by a space or the end of the line. */
const SENTENCE_END = /[.!?。！？]+(?=\s|$)/;

/** A tab's title from a message: its first line's first sentence, cut to length. */
export function titleOf(text: string): string {
  const line = shortenPaths(shownNoteText(text).trim().split("\n")[0].trim());
  const end = SENTENCE_END.exec(line);
  if (!end) return clipTitle(line);
  // A full stop is left out; a question, or an ellipsis, keeps its marks.
  const stop = end[0] === "." || end[0] === "。" ? "" : end[0];
  return clipTitle(line.slice(0, end.index) + stop || line);
}

/** A title cut to length, with an ellipsis where it was cut. */
export function clipTitle(title: string): string {
  const line = title.replace(/\s+/g, " ").trim();
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
}

const SEPARATORS = /[\\/]+/g;
/** A path from a root: `/`, `\`, `~/`, `./`, `../`, or a drive (`C:\`, `C:/`). */
const ROOTED = /^(?:[\\/]|~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/])/;
/** A path whose start alone says it is one: from home, from here, or from a drive. */
const MARKED = /^(?:~|\.{1,2}|[A-Za-z]:)[\\/]/;
/** A file's extension: a dot and a letter. */
const EXTENSION = /\.[A-Za-z]/;
/** Marks that may open a path without being part of it. */
const OPENERS = /^[("'`‘“<[{]+/;
/** What comes before a path in its word: up to a mark that opens it, as in `결과(/a/b.md)`. */
const BEFORE_PATH = /^[^\\/]*[("'`‘“<[{]/;
/** A path in quotes, which may hold spaces. */
const QUOTED = /(["'`‘“])([^"'`’”\n]+?)(["'`’”])/g;

/**
 * A line with each path in it shortened to its last part (a file's or a
 * folder's name), what follows it kept:
 * - From home, here, or a drive (`~/`, `./`, `../`, `C:\`, `C:/`): always.
 * - From the root (`/`, `\`, Git Bash's `/c/…`): with three separators or
 *   more, or a last part with an extension; so `/review` and `/api/status`
 *   stay.
 * - Any other word: with two separators or more and a last part with an
 *   extension; so `src/app.ts` and `read/write/run` stay.
 * - An address (`://`) stays.
 * A path in quotes may hold spaces; one from a root goes on past a space
 * while the next word goes on with a separator and the part before had no
 * extension.
 */
export function shortenPaths(line: string): string {
  const quoted = line.replace(QUOTED, (whole, open: string, path: string, close: string) =>
    ROOTED.test(path) && shortens(path) ? `${open}${lastPart(path)}${close}` : whole,
  );
  return shortenWords(quoted);
}

function shortenWords(line: string): string {
  const words = [...line.matchAll(/\S+/g)];
  let out = "";
  let at = 0;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!word) continue;
    const opener = BEFORE_PATH.exec(word[0])?.[0] ?? "";
    let path = word[0].slice(opener.length);
    let end = word.index + word[0].length;
    while (ROOTED.test(path) && goesOn(path)) {
      const next = words[i + 1];
      if (!next || line.slice(end, next.index) !== " " || !continues(next[0])) break;
      path += ` ${next[0]}`;
      end = next.index + next[0].length;
      i++;
    }
    out += line.slice(at, word.index) + opener + (shortens(path) ? lastPart(path) : path);
    at = end;
  }
  return out + line.slice(at);
}

/** Whether a path from a root may go on past a space: a folder of a long path. */
function goesOn(path: string): boolean {
  return (MARKED.test(path) || separators(path) >= 2) && !EXTENSION.test(lastPart(path));
}

/** Whether a word goes on with the path before it, rather than start one or be a word. */
function continues(word: string): boolean {
  return /[\\/]/.test(word) && !word.includes("://") && !ROOTED.test(word) && !OPENERS.test(word);
}

function shortens(path: string): boolean {
  if (path.includes("://")) return false;
  const last = lastPart(path);
  if (!last || last === path) return false;
  if (MARKED.test(path)) return true;
  if (ROOTED.test(path)) return separators(path) >= 3 || EXTENSION.test(last);
  return separators(path) >= 2 && EXTENSION.test(last);
}

function separators(path: string): number {
  return path.match(SEPARATORS)?.length ?? 0;
}

function lastPart(path: string): string {
  return path.split(SEPARATORS).filter(Boolean).at(-1) ?? "";
}
