const ESCAPED = /\\([!-/:-@[-`{-~])/g;
const ENTITY = /&(#[xX][0-9A-Fa-f]{1,6}|#\d{1,7}|[A-Za-z]{2,8});/g;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
const LINE_ANCHOR = /#L\d+(?:-L?\d+)?$/i;
const LINE_SUFFIX = /:\d+(?::\d+)?$/;

const INLINE = /\]\((<[^>\n]+>|[^)\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\)/g;
const AUTOLINK = /<((?:file:|[A-Za-z]:[\\/]|\/(?![A-Za-z][\w-]*>))[^>\s]+)>/g;
const REFERENCE = /^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]+>|\S+)/gm;
const HTML_ATTRIBUTE = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CODE = /`([^`\n]+)`/g;
const WRITTEN_INLINE = /\]\((<[^>\n]+>|[^)\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\)$/;
const WRITTEN_DEFINITION = /^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]+>|\S+)/;
const WINDOWS_PATH_TARGET = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/;

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

export function linkDestination(written: string): string {
  if (isWindowsPathTarget(written)) return withEntities(bareTarget(written));
  let href = written.trim().replace(ESCAPED, "$1");
  if (href.startsWith("<") && href.endsWith(">")) href = href.slice(1, -1);
  return withEntities(href);
}

export function writtenDestinationIn(markdown: string): string | null {
  return (WRITTEN_INLINE.exec(markdown) ?? WRITTEN_DEFINITION.exec(markdown))?.[1] ?? null;
}

export interface MarkdownSpan {
  start?: { offset?: number };
  end?: { offset?: number };
}

export function writtenHrefAt(markdown: string, span: MarkdownSpan | undefined): string | null {
  const start = span?.start?.offset;
  const end = span?.end?.offset;
  if (start === undefined || end === undefined) return null;
  const written = writtenDestinationIn(markdown.slice(start, end));
  return written === null ? null : linkHrefOf(written);
}

export function linkHrefOf(target: string): string {
  return withoutLineTail(bareTarget(target));
}

export function cleanLinkHref(raw: string): string {
  return withoutLineTail(decoded(linkDestination(raw)).replace(/\\/g, "/"));
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
  for (const match of text.matchAll(INLINE)) targets.push(match[1] as string);
  for (const match of text.matchAll(AUTOLINK)) targets.push(match[1] as string);
  for (const match of text.matchAll(REFERENCE)) targets.push(match[1] as string);
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
