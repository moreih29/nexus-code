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

interface Line {
  readonly start: number;
  readonly end: number;
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== "\n" && c !== "\r") continue;
    lines.push({ start, end: i });
    if (c === "\r" && text[i + 1] === "\n") i++;
    start = i + 1;
  }
  lines.push({ start, end: text.length });
  return lines;
}

function isBlank(text: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (text[i] !== " " && text[i] !== "\t") return false;
  return true;
}

interface Indent {
  readonly at: number;
  readonly col: number;
}

function indentAt(text: string, at: number, end: number, col: number): Indent {
  let i = at;
  let column = col;
  for (; i < end; i++) {
    if (text[i] === " ") column++;
    else if (text[i] === "\t") column += 4 - (column % 4);
    else break;
  }
  return { at: i, col: column };
}

function quotesAt(text: string, line: Line, most: number): { quotes: number; at: number } {
  let at = line.start;
  let quotes = 0;
  while (quotes < most) {
    const lead = indentAt(text, at, line.end, 0);
    if (lead.col > 3 || text[lead.at] !== ">") break;
    at = lead.at + 1;
    if (text[at] === " " || text[at] === "\t") at++;
    quotes++;
  }
  return { quotes, at };
}

function listMarkerEnd(text: string, at: number, end: number, interrupts: boolean): number {
  let i = at;
  const c = text[at];
  if (c === "*" || c === "+" || c === "-") i++;
  else {
    while (i < end && i - at < 9 && (text[i] as string) >= "0" && (text[i] as string) <= "9") i++;
    if (i === at || (text[i] !== "." && text[i] !== ")")) return -1;
    if (interrupts && text.slice(at, i) !== "1") return -1;
    i++;
  }
  if (i === end) return interrupts ? -1 : i;
  return text[i] === " " || text[i] === "\t" ? i : -1;
}

interface FenceRun {
  readonly char: string;
  readonly size: number;
  readonly rest: number;
}

function fenceAt(text: string, at: number, end: number): FenceRun | null {
  const char = text[at];
  if (char !== "`" && char !== "~") return null;
  let i = at;
  while (i < end && text[i] === char) i++;
  return i - at >= 3 ? { char, size: i - at, rest: i } : null;
}

function headingAt(text: string, at: number, end: number): boolean {
  let i = at;
  while (i < end && i - at < 7 && text[i] === "#") i++;
  return i > at && i - at <= 6 && (i === end || text[i] === " " || text[i] === "\t");
}

function startsBlock(text: string, at: number, end: number): boolean {
  return (
    text[at] === ">" ||
    text.startsWith("<!--", at) ||
    listMarkerEnd(text, at, end, true) !== -1 ||
    fenceAt(text, at, end) !== null ||
    headingAt(text, at, end)
  );
}

function blockBreaks(text: string, lines: readonly Line[]): number[] {
  const breaks: number[] = [];
  let quoted = 0;
  let paragraph = false;
  let code = false;
  let heading = false;
  let gap = false;
  for (const [n, line] of lines.entries()) {
    const { quotes, at } = quotesAt(text, line, Number.POSITIVE_INFINITY);
    const lead = indentAt(text, at, line.end, 0);
    const empty = lead.at === line.end;
    if (quotes < quoted && paragraph && !empty && !startsBlock(text, lead.at, line.end)) continue;
    const indented: boolean = !empty && lead.col >= 4 && (code || !paragraph);
    const opens =
      empty ||
      gap ||
      heading ||
      quotes !== quoted ||
      indented !== code ||
      (!indented && startsBlock(text, lead.at, line.end));
    if (n > 0 && opens) breaks.push(line.start);
    quoted = quotes;
    code = indented;
    gap = empty;
    heading = !empty && !indented && headingAt(text, lead.at, line.end);
    paragraph = !empty && !indented && !heading;
  }
  return breaks;
}

interface OpenFence extends FenceRun {
  readonly from: number;
  readonly quotes: number;
  readonly base: number;
}

interface Container {
  readonly at: number;
  readonly col: number;
  readonly base: number;
}

function blankFences(text: string, lines: readonly Line[], out: string[]): void {
  let fence: OpenFence | null = null;
  let items: number[] = [];
  let quoted = 0;
  let paragraph = false;
  let last = 0;
  let comment = false;
  for (const line of lines) {
    if (comment) {
      comment = !text.slice(line.start, line.end).includes("-->");
      last = line.end;
      continue;
    }
    if (fence) {
      const { quotes, at } = quotesAt(text, line, fence.quotes);
      const lead = indentAt(text, at, line.end, 0);
      const empty = lead.at === line.end;
      if (quotes === fence.quotes && (empty || lead.col >= fence.base)) {
        const close = !empty && lead.col - fence.base <= 3 && fenceAt(text, lead.at, line.end);
        if (
          close &&
          close.char === fence.char &&
          close.size >= fence.size &&
          isBlank(text, close.rest, line.end)
        ) {
          blank(fence.from, line.end, out);
          fence = null;
        }
        last = line.end;
        continue;
      }
      blank(fence.from, last, out);
      fence = null;
    }
    last = line.end;
    const { quotes, at } = quotesAt(text, line, Number.POSITIVE_INFINITY);
    const lead = indentAt(text, at, line.end, 0);
    const empty = lead.at === line.end;
    const lazy = paragraph && !empty && !startsBlock(text, lead.at, line.end);
    if (lazy && quotes < quoted) continue;
    if (quotes !== quoted) {
      items = [];
      quoted = quotes;
      paragraph = false;
    }
    if (empty) {
      paragraph = false;
      continue;
    }
    if (lazy && paragraph && lead.col < (items[items.length - 1] ?? 0)) continue;
    while (items.length > 0 && lead.col < (items[items.length - 1] as number)) items.pop();
    const inner = containerOf(text, line, lead, items, paragraph);
    if (inner.at !== lead.at) paragraph = false;
    if (inner.col - inner.base <= 3 && text.startsWith("<!--", inner.at)) {
      comment = !text.slice(inner.at + 2, line.end).includes("-->");
      paragraph = false;
      continue;
    }
    const opened = inner.col - inner.base <= 3 ? fenceAt(text, inner.at, line.end) : null;
    if (opened && !(opened.char === "`" && text.slice(opened.rest, line.end).includes("`"))) {
      fence = { ...opened, from: line.start, quotes, base: inner.base };
      paragraph = false;
    } else if (inner.col - inner.base <= 3) {
      paragraph = !headingAt(text, inner.at, line.end);
    }
  }
  if (fence) blank(fence.from, text.length, out);
}

function containerOf(
  text: string,
  line: Line,
  lead: Indent,
  items: number[],
  paragraph: boolean,
): Container {
  let base = items[items.length - 1] ?? 0;
  let { at, col } = lead;
  let interrupts = paragraph;
  while (col - base <= 3) {
    const marker = listMarkerEnd(text, at, line.end, interrupts);
    if (marker === -1) break;
    const markerCol = col + (marker - at);
    const after = indentAt(text, marker, line.end, markerCol);
    const content = after.at === line.end || after.col - markerCol > 4 ? markerCol + 1 : after.col;
    items.push(content);
    base = content;
    at = after.at;
    col = after.col;
    interrupts = false;
    if (content === markerCol + 1 && after.col !== content) break;
  }
  return { at, col, base };
}

function backslashed(text: string, at: number): boolean {
  let count = 0;
  for (let i = at - 1; i >= 0 && text[i] === "\\"; i--) count++;
  return count % 2 === 1;
}

interface Run {
  readonly at: number;
  readonly size: number;
  readonly paragraph: number;
}

function blankInline(text: string, lines: readonly Line[], out: string[]): void {
  const runs: Run[] = [];
  const bySize = new Map<number, number[]>();
  const breaks = blockBreaks(text, lines);
  let paragraph = 0;
  for (const line of lines) {
    while (paragraph < breaks.length && (breaks[paragraph] as number) <= line.start) paragraph++;
    for (let i = line.start; i < line.end; i++) {
      if (text[i] !== "`") continue;
      const at = i;
      while (i + 1 < line.end && text[i + 1] === "`") i++;
      const size = i - at + 1;
      const same = bySize.get(size) ?? [];
      same.push(runs.length);
      bySize.set(size, same);
      runs.push({ at, size, paragraph });
    }
  }
  const nextOfSize = new Map<number, number>();
  const closerOf = (k: number, size: number): Run | null => {
    const same = bySize.get(size);
    if (!same) return null;
    let p = nextOfSize.get(size) ?? 0;
    while (p < same.length && (same[p] as number) <= k) p++;
    nextOfSize.set(size, p);
    const closer = same[p] === undefined ? undefined : runs[same[p] as number];
    return closer && closer.paragraph === (runs[k] as Run).paragraph ? closer : null;
  };
  const none = text.length + 1;
  let comment = text.indexOf("<!--");
  if (comment === -1) comment = none;
  let close = -1;
  let k = 0;
  let line = 0;
  let brk = 0;
  let i = 0;
  for (;;) {
    if (comment < i) {
      comment = text.indexOf("<!--", i);
      if (comment === -1) comment = none;
    }
    while (k < runs.length && (runs[k] as Run).at < i) k++;
    const run = runs[k];
    if (run === undefined && comment === none) return;
    if (run !== undefined && run.at < comment) {
      const escaped = backslashed(text, run.at);
      const closer = closerOf(k, escaped ? run.size - 1 : run.size);
      if (closer === null || (escaped && run.size === 1)) {
        i = run.at + run.size;
        continue;
      }
      blank(escaped ? run.at + 1 : run.at, closer.at + closer.size, out);
      i = closer.at + closer.size;
      continue;
    }
    if (backslashed(text, comment)) {
      i = comment + 1;
      continue;
    }
    if (close !== none && close < comment + 2) {
      close = text.indexOf("-->", comment + 2);
      if (close === -1) close = none;
    }
    while (line < lines.length - 1 && (lines[line] as Line).end < comment) line++;
    const home = lines[line] as Line;
    if (prefixEnd(text, home) === comment) {
      let end = text.length;
      if (close !== none) {
        while (line < lines.length - 1 && (lines[line] as Line).end < close + 3) line++;
        end = (lines[line] as Line).end;
      }
      blank(comment, end, out);
      i = end;
      continue;
    }
    while (brk < breaks.length && (breaks[brk] as number) < comment) brk++;
    if (close !== none && (breaks[brk] ?? none) > close) {
      blank(comment, close + 3, out);
      i = close + 3;
      continue;
    }
    i = comment + 4;
  }
}

function prefixEnd(text: string, line: Line): number {
  const { at } = quotesAt(text, line, Number.POSITIVE_INFINITY);
  let lead = indentAt(text, at, line.end, 0);
  for (;;) {
    const marker = listMarkerEnd(text, lead.at, line.end, false);
    if (marker === -1) break;
    lead = indentAt(text, marker, line.end, 0);
  }
  return lead.col <= 3 ? lead.at : -1;
}

export function withoutCode(text: string): string {
  const out = text.split("");
  const lines = linesOf(text);
  blankFences(text, lines, out);
  blankInline(out.join(""), lines, out);
  return out.join("");
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

function afterDefinition(text: string, at: number, lastDefinition: number): boolean {
  if (lastDefinition < 0) return false;
  let end = at - 1;
  if (text[end] === "\n" && text[end - 1] === "\r") end--;
  let start = end;
  while (start > lastDefinition && text[start - 1] !== "\n" && text[start - 1] !== "\r") start--;
  return lastDefinition >= start;
}

function definitionsIn(prose: string, breaks: readonly number[]): Definitions {
  const targets = new Map<string, string>();
  const spans: [number, number][] = [];
  let last = -1;
  let brk = 0;
  for (const match of prose.matchAll(DEFINITION)) {
    while (brk < breaks.length && (breaks[brk] as number) < match.index) brk++;
    const opens = match.index === 0 || breaks[brk] === match.index;
    if (!opens && !afterDefinition(prose, match.index, last)) continue;
    const label = referenceLabel(match[1] as string);
    const target = definitionTargetAt(prose, match.index + match[0].length);
    if (!target || label === "") continue;
    spans.push([match.index, target.end]);
    last = target.end;
    if (!targets.has(label)) targets.set(label, target.written);
  }
  return { targets, spans };
}

export function writtenLinksIn(text: string): WrittenLink[] {
  return linksIn(withoutCode(text));
}

function linksIn(prose: string): WrittenLink[] {
  const links: WrittenLink[] = [];
  const breaks = blockBreaks(prose, linesOf(prose));
  const definitions = definitionsIn(prose, breaks);
  const openers: number[] = [];
  let floor = 0;
  let span = 0;
  let brk = 0;
  for (let i = 0; i < prose.length; i++) {
    while (
      span < definitions.spans.length &&
      (definitions.spans[span] as [number, number])[1] <= i
    ) {
      span++;
    }
    const definition = definitions.spans[span];
    if (definition && i >= definition[0]) {
      openers.length = 0;
      floor = 0;
      i = definition[1] - 1;
      continue;
    }
    if (brk < breaks.length && (breaks[brk] as number) <= i) {
      while (brk < breaks.length && (breaks[brk] as number) <= i) brk++;
      openers.length = 0;
      floor = 0;
    }
    const c = prose[i];
    if (c === "\\") {
      if (escapedAt(prose, i)) i++;
      continue;
    }
    if (c === "!" && prose[i + 1] === "[") {
      openers.push(i);
      i++;
      continue;
    }
    if (c === "[") {
      openers.push(i);
      continue;
    }
    if (c !== "]") continue;
    const open = openers.pop();
    if (open === undefined) continue;
    const image = prose[open] === "!";
    const inactive = !image && openers.length < floor;
    if (floor > openers.length) floor = openers.length;
    if (inactive || prose[i + 1] !== "(") continue;
    const target = inlineTargetAt(prose, i + 2);
    if (!target) continue;
    if (image)
      while (links.length > 0 && (links[links.length - 1] as WrittenLink).at > open) links.pop();
    else floor = openers.length;
    links.push({ written: target.written, image, at: i });
    i = target.end - 1;
  }
  if (definitions.targets.size > 0) {
    let within = 0;
    for (const match of prose.matchAll(REFERENCE)) {
      while (
        within < definitions.spans.length &&
        (definitions.spans[within] as [number, number])[1] <= match.index
      ) {
        within++;
      }
      if ((definitions.spans[within]?.[0] ?? Number.POSITIVE_INFINITY) <= match.index) continue;
      const after = prose[match.index + match[0].length];
      if (match[3] === undefined && after === "(") continue;
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

export function linkTargetSet(text: string, options: LinkTextOptions = {}): ReadonlySet<string> {
  const targets = new Set<string>();
  for (const target of linkTargetsIn(text, options)) {
    const cleaned = cleanLinkHref(target);
    if (cleaned !== "") targets.add(cleaned);
  }
  return targets;
}

export function linksTo(targets: ReadonlySet<string>, href: string): boolean {
  const wanted = cleanLinkHref(href);
  return wanted !== "" && targets.has(wanted);
}

export function textLinksTo(text: string, href: string, options: LinkTextOptions = {}): boolean {
  return linksTo(linkTargetSet(text, options), href);
}

export function isHtmlFile(path: string): boolean {
  return /\.x?html?$/i.test(path);
}
