/**
 * Rich text from a parsed Office file (a slide's text as HTML), read into
 * a tree of what may be drawn: a few text elements, each with only
 * typographic styles. The HTML is never handed to the browser to parse;
 * the preview builds elements from this tree. Anything else is dropped:
 * other elements keep only their text, attributes other than style go,
 * and so does any style that could load something (url(), image-set()).
 */

import { scanXml } from "./xml";

export type RichNode = string | RichElement;

export interface RichElement {
  readonly tag: RichTag;
  /** CSS properties by name, all from the allowed list. */
  readonly style: Readonly<Record<string, string>>;
  readonly children: readonly RichNode[];
}

const TAGS = [
  "p",
  "div",
  "span",
  "br",
  "ul",
  "ol",
  "li",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "sub",
  "sup",
] as const;

export type RichTag = (typeof TAGS)[number];

const ALLOWED_TAGS: ReadonlySet<string> = new Set(TAGS);

/** Elements HTML closes on their own. */
const VOID_TAGS: ReadonlySet<string> = new Set(["br", "img", "hr", "wbr"]);

const ALLOWED_STYLES: ReadonlySet<string> = new Set([
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-decoration",
  "text-decoration-line",
  "text-align",
  "text-indent",
  "text-shadow",
  "line-height",
  "letter-spacing",
  "vertical-align",
  "white-space",
  "list-style-type",
  "margin",
  "margin-top",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "padding",
  "padding-left",
  "padding-right",
  "padding-top",
  "padding-bottom",
]);

/** A value that could fetch something, or run something in old engines. */
const UNSAFE_VALUE = /url\s*\(|image-set|expression\s*\(|javascript:|[<>\\]/i;

export function sanitizeRichText(html: string): RichNode[] {
  const root: { children: RichNode[] } = { children: [] };
  /** Open elements, kept or not; a dropped one has no node of its own. */
  const stack: { name: string; node: { children: RichNode[] } }[] = [];
  const top = () => stack[stack.length - 1]?.node ?? root;

  // A `<` that cannot start a tag is text: pptxtojson writes a run's text
  // into its HTML as it is, so "a < b" arrives unescaped.
  scanXml(html.replace(/<(?![a-zA-Z/!?])/g, "&lt;"), {
    start(name, attrs, empty) {
      const tag = name.toLowerCase();
      const isVoid = empty || VOID_TAGS.has(tag);
      if (tag === "script" || tag === "style") {
        // Their text is not text the document shows.
        if (!isVoid) stack.push({ name: tag, node: { children: [] } });
        return;
      }
      if (!ALLOWED_TAGS.has(tag)) {
        if (!isVoid) stack.push({ name: tag, node: top() });
        return;
      }
      const node = { tag: tag as RichTag, style: parseStyle(attrs.style ?? ""), children: [] };
      top().children.push(node);
      if (!isVoid) stack.push({ name: tag, node });
    },
    end(name) {
      const tag = name.toLowerCase();
      if (VOID_TAGS.has(tag)) return;
      const at = stack.map((open) => open.name).lastIndexOf(tag);
      if (at !== -1) stack.length = at;
    },
    text(text) {
      if (text !== "") top().children.push(text.replace(/&nbsp;/g, " "));
    },
  });
  return root.children;
}

/** The allowed properties of a style attribute. */
export function parseStyle(text: string): Record<string, string> {
  const style: Record<string, string> = {};
  for (const declaration of splitDeclarations(text)) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration
      .slice(colon + 1)
      .replace(/!important\s*$/i, "")
      .trim();
    if (ALLOWED_STYLES.has(property) && value !== "" && !UNSAFE_VALUE.test(value)) {
      style[property] = value;
    }
  }
  return style;
}

/** Declarations split at `;`, but not at one inside quotes (a font's name). */
function splitDeclarations(text: string): string[] {
  const parts: string[] = [];
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ";") {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}
