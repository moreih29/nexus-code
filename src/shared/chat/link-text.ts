const ESCAPED = /\\([!-/:-@[-`{-~])/g;
const ESCAPABLE = /^[!-/:-@[-`{-~]$/;
const ENTITY = /&(#[xX][0-9A-Fa-f]{1,6}|#\d{1,7}|[A-Za-z]{2,8});/g;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
const LINE_ANCHOR = /#L\d+(?:-L?\d+)?$/i;
const LINE_SUFFIX = /:\d+(?::\d+)?$/;

const AUTOLINK = /<((?:file:|[A-Za-z]:[\\/]|\/(?![A-Za-z][\w-]*>))[^>\s]+)>/g;
const DEFINITION = /^[ \t>]*\[((?:[^\][\\\n]|\\.){1,999})\]:/gm;
const REFERENCE = /(!?)\[((?:[^\][\\\n]|\\.)+)\](?:\[((?:[^\][\\\n]|\\.)*)\])?/g;
const HTML_ATTRIBUTE = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CODE = /`([^`\n]+)`/g;
const FENCE = /^[ \t>]*(`{3,}|~{3,})(.*)$/;
const WINDOWS_PATH_TARGET = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/;
const MAX_PAREN_DEPTH = 32;

function entity(name: string): string | undefined {
  if (name.startsWith("#")) {
    const hex = name[1] === "x" || name[1] === "X";
    const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : undefined;
  }
  return NAMED_ENTITIES[name];
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function withoutLineTail(href: string): string {
  const anchored = href.replace(LINE_ANCHOR, "");
  const tail = LINE_SUFFIX.exec(anchored);
  return tail && /[./\\]/.test(anchored.slice(0, tail.index))
    ? anchored.slice(0, tail.index)
    : anchored;
}

function bareTarget(written: string): string {
  const trimmed = written.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
}

function withEntities(text: string): string {
  return text.replace(ENTITY, (all, name: string) => entity(name) ?? all);
}

export function isWindowsPathTarget(written: string): boolean {
  return WINDOWS_PATH_TARGET.test(bareTarget(written));
}

export function commonMarkDestination(written: string): string {
  let href = written.trim().replace(ESCAPED, "$1");
  if (href.startsWith("<") && href.endsWith(">")) href = href.slice(1, -1);
  return withEntities(href);
}

export function linkDestination(written: string): string {
  if (isWindowsPathTarget(written)) return withEntities(bareTarget(written));
  return commonMarkDestination(written);
}

export function linkHrefOf(target: string): string {
  return withoutLineTail(bareTarget(target));
}

export function cleanLinkHref(raw: string): string {
  return withoutLineTail(decoded(linkDestination(raw)).replace(/\\/g, "/"));
}

function escapedAt(text: string, at: number): boolean {
  return text[at] === "\\" && at + 1 < text.length && ESCAPABLE.test(text[at + 1] as string);
}

function lineEndAt(text: string, at: number): number {
  if (text[at] === "\n") return 1;
  if (text[at] === "\r") return text[at + 1] === "\n" ? 2 : 1;
  return 0;
}

function skipWhitespace(text: string, at: number): number {
  let i = at;
  let lines = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    const end = lineEndAt(text, i);
    if (end === 0 || lines > 0) break;
    lines++;
    i += end;
  }
  return i;
}

export interface ScannedTarget {
  readonly written: string;
  readonly start: number;
  readonly end: number;
}

function scanTarget(text: string, at: number): ScannedTarget | null {
  if (text[at] === "<") {
    for (let i = at + 1; i < text.length; i++) {
      if (escapedAt(text, i)) {
        i++;
        continue;
      }
      const c = text[i];
      if (c === "\n" || c === "\r" || c === "<") return null;
      if (c === ">") return { written: text.slice(at, i + 1), start: at, end: i + 1 };
    }
    return null;
  }
  let depth = 0;
  let i = at;
  while (i < text.length) {
    if (escapedAt(text, i)) {
      i += 2;
      continue;
    }
    const c = text[i] as string;
    if (c <= " " || c === "\x7f") break;
    if (c === "(") {
      depth++;
      if (depth > MAX_PAREN_DEPTH) return null;
    } else if (c === ")") {
      if (depth === 0) break;
      depth--;
    }
    i++;
  }
  if (depth !== 0 || i === at) return null;
  return { written: text.slice(at, i), start: at, end: i };
}

function scanTitle(text: string, at: number): number | null {
  const open = text[at];
  if (open !== '"' && open !== "'" && open !== "(") return null;
  const close = open === "(" ? ")" : open;
  let blank = false;
  for (let i = at + 1; i < text.length; i++) {
    if (escapedAt(text, i)) {
      i++;
      blank = false;
      continue;
    }
    const c = text[i];
    if (c === close) return i + 1;
    if (open === "(" && c === "(") return null;
    const end = lineEndAt(text, i);
    if (end > 0) {
      if (blank) return null;
      blank = true;
      i += end - 1;
    } else if (c !== " " && c !== "\t") blank = false;
  }
  return null;
}

export function inlineTargetAt(text: string, at: number): ScannedTarget | null {
  const start = skipWhitespace(text, at);
  if (text[start] === ")") return null;
  const target = scanTarget(text, start);
  if (!target) return null;
  const gap = skipWhitespace(text, target.end);
  if (text[gap] === ")") return { ...target, end: gap + 1 };
  if (gap === target.end) return null;
  const titled = scanTitle(text, gap);
  if (titled === null) return null;
  const after = skipWhitespace(text, titled);
  return text[after] === ")" ? { ...target, end: after + 1 } : null;
}

export function definitionTargetAt(text: string, at: number): ScannedTarget | null {
  const target = scanTarget(text, skipWhitespace(text, at));
  if (!target) return null;
  const next = text[target.end];
  return next === undefined || /\s/.test(next) ? target : null;
}

function blank(from: number, to: number, into: string[]): void {
  for (let i = from; i < to; i++) if (into[i] !== "\n" && into[i] !== "\r") into[i] = " ";
}

export function withoutCode(text: string): string {
  const out = text.split("");
  const lines = text.split("\n");
  let offset = 0;
  let fence: { char: string; size: number; from: number } | null = null;
  for (const line of lines) {
    const opened = FENCE.exec(line);
    if (fence) {
      const size = opened?.[1]?.length ?? 0;
      if (opened && opened[1]?.[0] === fence.char && size >= fence.size && !opened[2]?.trim()) {
        blank(fence.from, offset + line.length, out);
        fence = null;
      }
    } else if (opened && !(opened[1]?.[0] === "`" && opened[2]?.includes("`"))) {
      fence = { char: opened[1]?.[0] as string, size: opened[1]?.length ?? 3, from: offset };
    }
    offset += line.length + 1;
  }
  if (fence) blank(fence.from, text.length, out);
  const prose = out.join("");
  for (let i = 0; i < prose.length; i++) {
    if (prose[i] !== "`") continue;
    let run = 1;
    while (prose[i + run] === "`") run++;
    if (i > 0 && prose[i - 1] === "\\") {
      i += run - 1;
      continue;
    }
    const close = closingRun(prose, i + run, run);
    if (close === null) {
      i += run - 1;
      continue;
    }
    blank(i, close + run, out);
    i = close + run - 1;
  }
  return out.join("");
}

function closingRun(text: string, from: number, size: number): number | null {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\n" && /^[ \t]*(?:\r?\n|$)/.test(text.slice(i + 1, i + 80))) return null;
    if (text[i] !== "`") continue;
    let run = 1;
    while (text[i + run] === "`") run++;
    if (run === size) return i;
    i += run - 1;
  }
  return null;
}

export function referenceLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

export interface WrittenLink {
  readonly written: string;
  readonly image: boolean;
  readonly at: number;
}

interface Definitions {
  readonly targets: Map<string, string>;
  readonly spans: [number, number][];
}

function definitionsIn(prose: string): Definitions {
  const targets = new Map<string, string>();
  const spans: [number, number][] = [];
  for (const match of prose.matchAll(DEFINITION)) {
    const label = referenceLabel(match[1] as string);
    const target = definitionTargetAt(prose, match.index + match[0].length);
    if (!target || label === "") continue;
    spans.push([match.index, target.end]);
    if (!targets.has(label)) targets.set(label, target.written);
  }
  return { targets, spans };
}

function labelStart(text: string, close: number): number | null {
  let depth = 0;
  for (let i = close - 1; i >= 0; i--) {
    const c = text[i];
    if (i > 0 && text[i - 1] === "\\") continue;
    if (c === "]") depth++;
    else if (c === "[") {
      if (depth === 0) return i;
      depth--;
    } else if (c === "\n" && text[i - 1] === "\n") return null;
  }
  return null;
}

export function writtenLinksIn(text: string): WrittenLink[] {
  return linksIn(withoutCode(text));
}

function linksIn(prose: string): WrittenLink[] {
  const links: WrittenLink[] = [];
  const definitions = definitionsIn(prose);
  const inDefinition = (at: number) =>
    definitions.spans.some(([start, end]) => at >= start && at < end);
  for (let i = prose.indexOf("]("); i !== -1; i = prose.indexOf("](", i + 1)) {
    if ((i > 0 && prose[i - 1] === "\\") || inDefinition(i)) continue;
    const target = inlineTargetAt(prose, i + 2);
    if (!target) continue;
    const open = labelStart(prose, i);
    links.push({ written: target.written, image: open !== null && prose[open - 1] === "!", at: i });
    i = target.end - 1;
  }
  if (definitions.targets.size > 0) {
    for (const match of prose.matchAll(REFERENCE)) {
      const after = prose[match.index + match[0].length];
      if (match[3] === undefined && (after === "(" || after === ":")) continue;
      const label = referenceLabel(match[3] ? match[3] : (match[2] as string));
      const written = definitions.targets.get(label);
      if (written !== undefined) links.push({ written, image: match[1] === "!", at: match.index });
    }
  }
  return links.sort((a, b) => a.at - b.at);
}

export interface LinkTextOptions {
  readonly html?: boolean;
  readonly code?: (written: string) => boolean;
}

export function linkTargetsIn(
  text: string,
  { html = false, code }: LinkTextOptions = {},
): string[] {
  const targets: string[] = [];
  const prose = html ? text : withoutCode(text);
  for (const link of linksIn(prose)) targets.push(link.written);
  for (const match of prose.matchAll(AUTOLINK)) targets.push(match[1] as string);
  if (html) {
    for (const match of text.matchAll(HTML_ATTRIBUTE)) targets.push(match[1] ?? match[2] ?? "");
  }
  if (code) {
    for (const match of text.matchAll(CODE)) {
      const written = match[1] as string;
      if (code(written)) targets.push(written);
    }
  }
  return targets.filter((target) => target !== "");
}

export function sameLinkHref(a: string, b: string): boolean {
  const cleaned = cleanLinkHref(a);
  return cleaned !== "" && cleaned === cleanLinkHref(b);
}

export function textLinksTo(text: string, href: string, options: LinkTextOptions = {}): boolean {
  const wanted = cleanLinkHref(href);
  if (wanted === "") return false;
  return linkTargetsIn(text, options).some((target) => cleanLinkHref(target) === wanted);
}

export function isHtmlFile(path: string): boolean {
  return /\.x?html?$/i.test(path);
}
