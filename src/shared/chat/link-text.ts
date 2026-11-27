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

const AUTOLINK = /<((?:file:|[A-Za-z]:[\\/]|\/(?![A-Za-z][\w-]*>))[^<>\s]+)>/g;
const HTML_ATTRIBUTE = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CODE = /`([^`\n]+)`/g;
const WINDOWS_PATH_TARGET = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/;
const MAX_PAREN_DEPTH = 32;
const MAX_LABEL = 999;

export const LINK_TEXT_TIME_LIMIT_MS = 5000;
const CHECK_EVERY = 1024;

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

export interface ExtractionLimit {
  readonly ms?: number;
  readonly now?: () => number;
  readonly every?: number;
}

let writeStop: (line: string) => void = (line) => console.warn(line);

export function logLinkTextStops(write: (line: string) => void): void {
  writeStop = write;
}

class Budget {
  cut: number;
  stoppedIn: string | null = null;
  private stoppedAt = 0;
  private steps = 0;
  private readonly now: () => number;
  private readonly ms: number;
  private readonly every: number;
  private readonly started: number;

  constructor(
    readonly length: number,
    limit: ExtractionLimit = {},
  ) {
    this.cut = length;
    this.now = limit.now ?? (() => performance.now());
    this.ms = limit.ms ?? LINK_TEXT_TIME_LIMIT_MS;
    this.every = Math.max(1, limit.every ?? CHECK_EVERY);
    this.started = this.now();
  }

  private late(): boolean {
    if (this.stoppedIn !== null) return true;
    if (++this.steps < this.every) return false;
    this.steps = 0;
    return this.now() - this.started > this.ms;
  }

  stops(pass: string, at: number): boolean {
    if (at >= this.cut) return true;
    if (!this.late()) return false;
    this.cut = at;
    this.stop(pass, at);
    return true;
  }

  private stop(pass: string, at: number): void {
    if (this.stoppedIn !== null) return;
    this.stoppedIn = pass;
    this.stoppedAt = at;
  }

  ends(pass: string): boolean {
    if (!this.late()) return false;
    this.stop(pass, this.length);
    return true;
  }

  report(): void {
    if (this.stoppedIn === null) return;
    const ms = Math.round(this.now() - this.started);
    writeStop(
      `link text: stopped after ${ms} ms in the ${this.stoppedIn} pass at ${this.stoppedAt} of ${this.length} characters`,
    );
  }
}

function escapedAt(text: string, at: number): boolean {
  return text[at] === "\\" && at + 1 < text.length && ESCAPABLE.test(text[at + 1] as string);
}

function lineEndAt(text: string, at: number): number {
  if (text[at] === "\n") return 1;
  if (text[at] === "\r") return text[at + 1] === "\n" ? 2 : 1;
  return 0;
}

function skipWhitespace(text: string, at: number, limit: number): number {
  let i = at;
  let lines = 0;
  while (i < limit) {
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
  return Math.min(i, limit);
}

function skipSpaces(text: string, at: number, limit: number): number {
  let i = at;
  while (i < limit && (text[i] === " " || text[i] === "\t")) i++;
  return i;
}

function endsLine(text: string, at: number, limit: number): boolean {
  return at >= limit || lineEndAt(text, at) > 0;
}

export interface ScannedTarget {
  readonly written: string;
  readonly start: number;
  readonly end: number;
}

function scanTarget(text: string, at: number, limit: number): ScannedTarget | null {
  if (text[at] === "<") {
    for (let i = at + 1; i < limit; i++) {
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
  while (i < limit) {
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
  const end = Math.min(i, limit);
  return { written: text.slice(at, end), start: at, end };
}

function scanTitle(text: string, at: number, limit: number): number | null {
  const open = text[at];
  if (open !== '"' && open !== "'" && open !== "(") return null;
  const close = open === "(" ? ")" : open;
  let blank = false;
  for (let i = at + 1; i < limit; i++) {
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

export function inlineTargetAt(
  text: string,
  at: number,
  limit: number = text.length,
): ScannedTarget | null {
  const start = skipWhitespace(text, at, limit);
  if (text[start] === ")") return null;
  const target = scanTarget(text, start, limit);
  if (!target) return null;
  const gap = skipWhitespace(text, target.end, limit);
  if (gap < limit && text[gap] === ")") return { ...target, end: gap + 1 };
  if (gap === target.end) return null;
  const titled = scanTitle(text, gap, limit);
  if (titled === null) return null;
  const after = skipWhitespace(text, titled, limit);
  return after < limit && text[after] === ")" ? { ...target, end: after + 1 } : null;
}

export function definitionTargetAt(text: string, at: number): ScannedTarget | null {
  const target = scanTarget(text, skipWhitespace(text, at, text.length), text.length);
  if (!target) return null;
  const next = text[target.end];
  return next === undefined || /\s/.test(next) ? target : null;
}

interface DefinitionEnd {
  readonly target: ScannedTarget;
  readonly end: number;
}

function definitionEndAt(text: string, at: number, limit: number): DefinitionEnd | null {
  const target = scanTarget(text, skipWhitespace(text, at, limit), limit);
  if (!target) return null;
  const rest = skipSpaces(text, target.end, limit);
  if (endsLine(text, rest, limit)) {
    const next = skipWhitespace(text, rest, limit);
    const titled = next > rest ? scanTitle(text, next, limit) : null;
    if (titled !== null) {
      const after = skipSpaces(text, titled, limit);
      if (endsLine(text, after, limit)) return { target, end: after };
    }
    return { target, end: rest };
  }
  if (rest === target.end) return null;
  const titled = scanTitle(text, rest, limit);
  if (titled === null) return null;
  const after = skipSpaces(text, titled, limit);
  return endsLine(text, after, limit) ? { target, end: after } : null;
}

function blank(from: number, to: number, into: string[]): void {
  for (let i = from; i < to; i++) if (into[i] !== "\n" && into[i] !== "\r") into[i] = " ";
}

interface Line {
  readonly start: number;
  readonly end: number;
}

function linesOf(text: string, budget: Budget): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== "\n" && c !== "\r") continue;
    if (budget.stops("lines", start)) return lines;
    lines.push({ start, end: i });
    if (c === "\r" && text[i + 1] === "\n") i++;
    start = i + 1;
  }
  if (!budget.stops("lines", start)) lines.push({ start, end: text.length });
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

function bareItem(text: string, at: number, end: number): boolean {
  let i = at;
  for (;;) {
    const marker = listMarkerEnd(text, i, end, false);
    if (marker === -1) return false;
    i = indentAt(text, marker, end, 0).at;
    if (i === end) return true;
  }
}

function blockBreaks(text: string, lines: readonly Line[], budget: Budget): number[] {
  const breaks: number[] = [];
  let quoted = 0;
  let paragraph = false;
  let code = false;
  let heading = false;
  let gap = false;
  for (const [n, line] of lines.entries()) {
    if (budget.stops("breaks", line.start)) break;
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
    const bare = !empty && !indented && bareItem(text, lead.at, line.end);
    code = indented;
    gap = empty || bare;
    heading = !empty && !indented && headingAt(text, lead.at, line.end);
    paragraph = !empty && !indented && !heading && !bare;
  }
  return breaks;
}

interface OpenBlock {
  readonly from: number;
  readonly quotes: number;
  readonly base: number;
}

interface OpenFence extends FenceRun, OpenBlock {}

interface Container {
  readonly at: number;
  readonly col: number;
  readonly base: number;
}

function blankFences(text: string, lines: readonly Line[], out: string[], budget: Budget): void {
  let fence: OpenFence | null = null;
  let comment: OpenBlock | null = null;
  let items: number[] = [];
  let quoted = 0;
  let paragraph = false;
  let last = 0;
  for (const line of lines) {
    const open: OpenBlock | null = fence ?? comment;
    if (budget.stops("fences", line.start)) {
      if (open) blank(open.from, line.start, out);
      return;
    }
    if (open) {
      const { quotes, at } = quotesAt(text, line, open.quotes);
      const lead = indentAt(text, at, line.end, 0);
      const empty = lead.at === line.end;
      if (quotes === open.quotes && (empty || lead.col >= open.base)) {
        if (fence) {
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
        } else if (text.slice(at, line.end).includes("-->")) {
          blank(open.from, line.end, out);
          comment = null;
        }
        last = line.end;
        continue;
      }
      blank(open.from, last, out);
      fence = null;
      comment = null;
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
    const near = inner.col - inner.base <= 3;
    if (near && text.startsWith("<!--", inner.at)) {
      if (text.slice(inner.at + 2, line.end).includes("-->")) blank(inner.at, line.end, out);
      else comment = { from: inner.at, quotes, base: inner.base };
      paragraph = false;
      continue;
    }
    const opened = near ? fenceAt(text, inner.at, line.end) : null;
    if (opened && !(opened.char === "`" && text.slice(opened.rest, line.end).includes("`"))) {
      fence = { ...opened, from: line.start, quotes, base: inner.base };
      paragraph = false;
    } else if (near) {
      paragraph = !headingAt(text, inner.at, line.end);
    }
  }
  const open = fence ?? comment;
  if (open) blank(open.from, text.length, out);
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

function blankInline(text: string, lines: readonly Line[], out: string[], budget: Budget): void {
  const runs: Run[] = [];
  const bySize = new Map<number, number[]>();
  const breaks = blockBreaks(text, lines, budget);
  let paragraph = 0;
  for (const line of lines) {
    if (budget.stops("spans", line.start)) return;
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
  let comment = -1;
  let close = -1;
  let k = 0;
  let brk = 0;
  let i = 0;
  for (;;) {
    if (budget.stops("spans", i)) return;
    if (comment < i) {
      comment = text.indexOf("<!--", i);
      if (comment === -1 || comment >= budget.cut) comment = none;
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

function withoutCodeIn(text: string, lines: readonly Line[], budget: Budget): string {
  const out = text.split("");
  blankFences(text, lines, out, budget);
  if (budget.stoppedIn !== null) return text;
  blankInline(out.join(""), lines, out, budget);
  return out.join("");
}

export function withoutCode(text: string): string {
  const budget = new Budget(text.length);
  const prose = withoutCodeIn(text, linesOf(text, budget), budget);
  budget.report();
  return prose;
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

function labelEndAt(text: string, at: number, end: number): number {
  let units = 0;
  for (let i = at + 1; i < end; i++) {
    const c = text[i];
    if (c === "]") return units > 0 ? i : -1;
    if (c === "[" || ++units > MAX_LABEL) return -1;
    if (c === "\\" && i + 1 < end) i++;
  }
  return -1;
}

function definitionsIn(
  prose: string,
  lines: readonly Line[],
  breaks: readonly number[],
  budget: Budget,
): Definitions {
  const targets = new Map<string, string>();
  const spans: [number, number][] = [];
  let brk = 0;
  let covered = -1;
  let defined = -2;
  for (const [n, line] of lines.entries()) {
    if (budget.stops("definitions", line.start)) break;
    if (n <= covered) continue;
    while (brk < breaks.length && (breaks[brk] as number) < line.start) brk++;
    const opens = n === 0 || breaks[brk] === line.start || defined === n - 1;
    if (!opens) continue;
    const at = prefixEnd(prose, line);
    if (at === -1 || prose[at] !== "[") continue;
    const close = labelEndAt(prose, at, line.end);
    if (close === -1 || prose[close + 1] !== ":") continue;
    const label = referenceLabel(prose.slice(at + 1, close));
    if (label === "") continue;
    const next = breaks[brk] === line.start ? breaks[brk + 1] : breaks[brk];
    const found = definitionEndAt(prose, close + 2, Math.min(next ?? prose.length, budget.cut));
    if (!found) continue;
    spans.push([at, found.end]);
    if (!targets.has(label)) targets.set(label, found.target.written);
    covered = n;
    while (covered + 1 < lines.length && (lines[covered] as Line).end < found.end) covered++;
    defined = covered;
  }
  return { targets, spans };
}

function inlineLinksIn(
  prose: string,
  breaks: readonly number[],
  definitions: Definitions,
  budget: Budget,
): WrittenLink[] {
  const links: WrittenLink[] = [];
  const openers: number[] = [];
  let floor = 0;
  let span = 0;
  let brk = 0;
  for (let i = 0; i < prose.length; i++) {
    if (budget.stops("links", i)) break;
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
    const limit = Math.min(breaks[brk] ?? prose.length, budget.cut);
    const target = inlineTargetAt(prose, i + 2, limit);
    if (!target) continue;
    if (image)
      while (links.length > 0 && (links[links.length - 1] as WrittenLink).at > open) links.pop();
    else floor = openers.length;
    links.push({ written: target.written, image, at: i });
    i = target.end - 1;
  }
  return links;
}

function labelAfter(prose: string, at: number, end: number): number {
  for (let j = at; j < end; j++) {
    const c = prose[j];
    if (c === "\\" && j + 1 < end && lineEndAt(prose, j + 1) === 0) {
      j++;
      continue;
    }
    if (c === "]") return j;
    if (c === "[" || c === "\n" || c === "\r") return -1;
  }
  return -1;
}

function referencesIn(
  prose: string,
  definitions: Definitions,
  links: WrittenLink[],
  budget: Budget,
): void {
  if (definitions.targets.size === 0) return;
  const end = budget.cut;
  let open = -1;
  let within = 0;
  for (let i = 0; i < end; i++) {
    if (budget.ends("references")) return;
    const c = prose[i];
    if (c === "\\" && i + 1 < end && lineEndAt(prose, i + 1) === 0) {
      i++;
      continue;
    }
    if (c === "[") {
      open = i;
      continue;
    }
    if (c !== "]") {
      if (c === "\n" || c === "\r") open = -1;
      continue;
    }
    const from = open;
    open = -1;
    if (from === -1 || i === from + 1) continue;
    let stop = i + 1;
    let second: string | undefined;
    if (prose[i + 1] === "[") {
      const close = labelAfter(prose, i + 2, end);
      if (close !== -1) {
        second = prose.slice(i + 2, close);
        stop = close + 1;
      }
    }
    const first = prose.slice(from + 1, i);
    const image = prose[from - 1] === "!";
    const at = image ? from - 1 : from;
    i = stop - 1;
    while (
      within < definitions.spans.length &&
      (definitions.spans[within] as [number, number])[1] <= at
    ) {
      within++;
    }
    if ((definitions.spans[within]?.[0] ?? Number.POSITIVE_INFINITY) <= at) continue;
    if (second === undefined && prose[stop] === "(") continue;
    const label = referenceLabel(second ? second : first);
    const written = definitions.targets.get(label);
    if (written !== undefined) links.push({ written, image, at });
  }
}

interface Extraction {
  readonly prose: string;
  readonly links: WrittenLink[];
  readonly safe: number;
}

function safeEnd(budget: Budget, breaks: readonly number[]): number {
  if (budget.cut >= budget.length) return Number.POSITIVE_INFINITY;
  let safe = 0;
  for (const at of breaks) {
    if (at > budget.cut) break;
    safe = at;
  }
  return safe;
}

function extract(text: string, html: boolean, budget: Budget): Extraction {
  const lines = linesOf(text, budget);
  const prose = html || budget.stoppedIn !== null ? text : withoutCodeIn(text, lines, budget);
  if (budget.stoppedIn !== null) return { prose, links: [], safe: 0 };
  const breaks = blockBreaks(prose, lines, budget);
  const definitions = definitionsIn(prose, lines, breaks, budget);
  const links = inlineLinksIn(prose, breaks, definitions, budget);
  referencesIn(prose, definitions, links, budget);
  const safe = safeEnd(budget, breaks);
  return {
    prose,
    safe,
    links: links.filter((link) => link.at < safe).sort((a, b) => a.at - b.at),
  };
}

export function writtenLinksIn(text: string, limit?: ExtractionLimit): WrittenLink[] {
  const budget = new Budget(text.length, limit);
  const { links } = extract(text, false, budget);
  budget.report();
  return links;
}

export interface LinkTextOptions {
  readonly html?: boolean;
  readonly code?: (written: string) => boolean;
  readonly limit?: ExtractionLimit;
}

function targetsIn(
  text: string,
  { html = false, code }: LinkTextOptions,
  budget: Budget,
): string[] {
  const { prose, links, safe } = extract(text, html, budget);
  const targets = links.map((link) => link.written);
  for (const match of prose.matchAll(AUTOLINK)) {
    if (match.index >= safe || budget.ends("autolinks")) break;
    targets.push(match[1] as string);
  }
  if (html) {
    for (const match of text.matchAll(HTML_ATTRIBUTE)) {
      if (budget.ends("attributes")) break;
      targets.push(match[1] ?? match[2] ?? "");
    }
  }
  if (code) {
    for (const match of text.matchAll(CODE)) {
      if (budget.ends("code")) break;
      const written = match[1] as string;
      if (code(written)) targets.push(written);
    }
  }
  return targets.filter((target) => target !== "");
}

export function linkTargetsIn(text: string, options: LinkTextOptions = {}): string[] {
  const budget = new Budget(text.length, options.limit);
  const targets = targetsIn(text, options, budget);
  budget.report();
  return targets;
}

export function sameLinkHref(a: string, b: string): boolean {
  const cleaned = cleanLinkHref(a);
  return cleaned !== "" && cleaned === cleanLinkHref(b);
}

export function linkTargetSet(text: string, options: LinkTextOptions = {}): ReadonlySet<string> {
  const budget = new Budget(text.length, options.limit);
  const written = new Set<string>();
  const targets = new Set<string>();
  for (const target of targetsIn(text, options, budget)) {
    if (written.has(target)) continue;
    if (budget.ends("targets")) break;
    written.add(target);
    const cleaned = cleanLinkHref(target);
    if (cleaned !== "") targets.add(cleaned);
  }
  budget.report();
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
