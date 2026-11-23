import { shownNoteText } from "../../../shared/notes/line-report";

export const TITLE_CHARS = 60;

const SENTENCE_END = /[.!?。！？]+(?=\s|$)/;

export function titleOf(text: string): string {
  const line = shortenPaths(shownNoteText(text).trim().split("\n")[0].trim());
  const end = SENTENCE_END.exec(line);
  if (!end) return clipTitle(line);
  const stop = end[0] === "." || end[0] === "。" ? "" : end[0];
  return clipTitle(line.slice(0, end.index) + stop || line);
}

export function clipTitle(title: string): string {
  const line = title.replace(/\s+/g, " ").trim();
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
}

const SEPARATORS = /[\\/]+/g;
const ROOTED = /^(?:[\\/]|~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/])/;
const MARKED = /^(?:~|\.{1,2}|[A-Za-z]:)[\\/]/;
const EXTENSION = /\.[A-Za-z]/;
const OPENERS = /^[("'`‘“<[{]+/;
const BEFORE_PATH = /^[^\\/]*[("'`‘“<[{]/;
const QUOTED = /(["'`‘“])([^"'`’”\n]+?)(["'`’”])/g;

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

function goesOn(path: string): boolean {
  return (MARKED.test(path) || separators(path) >= 2) && !EXTENSION.test(lastPart(path));
}

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
