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

export function linkHrefOf(target: string): string {
  const trimmed = target.trim();
  const bare = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
  return withoutLineTail(bare);
}

export function cleanLinkHref(raw: string): string {
  let href = raw.trim().replace(ESCAPED, "$1");
  if (href.startsWith("<") && href.endsWith(">")) href = href.slice(1, -1);
  href = href.replace(ENTITY, (all, name: string) => entity(name) ?? all);
  return withoutLineTail(decoded(href).replace(/\\/g, "/"));
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
