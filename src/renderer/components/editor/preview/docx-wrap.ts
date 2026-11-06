// Hangul broken into lines where Word breaks it. A paragraph whose
// wordWrap is off (Korean Word's "allow Hangul words to break" unchecked,
// as its template sets every paragraph) moves a Hangul word that does not
// fit to the next line whole, as it does a Latin word. docx-preview drops
// the setting, and the browser breaks Hangul between any two letters, so
// such a paragraph's Hangul is set to keep its words. Only its Hangul:
// Chinese and Japanese in it, set apart, still break between letters. A
// word longer than the line still breaks.

import { strFromU8, unzipSync } from "fflate";

/**
 * Whether a paragraph may break Hangul within a word (w:wordWrap), by
 * docx-preview's class for its style, and for a paragraph with no style.
 */
export interface HangulWrap {
  byClass: ReadonlyMap<string, boolean>;
  plain: boolean;
}

const STYLES_PART = "word/styles.xml";

/** A style, its attributes and, unless it is empty, what it holds. */
const STYLE = /<w:style\b([^>]*?)(?:\/>|>([\s\S]*?)<\/w:style>)/g;
const ATTRIBUTE = /\bw:(\w+)=(["'])(.*?)\2/g;
const PARAGRAPH_DEFAULTS = /<w:pPrDefault\b[^>]*>([\s\S]*?)<\/w:pPrDefault>/;
const PARAGRAPH_PROPERTIES = /<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/;
/** The properties a tracked change replaced, which no longer apply. */
const PROPERTIES_CHANGE = /<w:pPrChange\b[\s\S]*?<\/w:pPrChange>/g;
const WORD_WRAP = /<w:wordWrap\b([^>]*)>/;
const BASED_ON = /<w:basedOn\b([^>]*)>/;
const ENTITY = /&(?:(amp|lt|gt|quot|apos)|#(\d+)|#x([0-9a-f]+));/gi;
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const HANGUL = /\p{Script=Hangul}/u;
/**
 * Chinese or Japanese, with the punctuation set among it, which breaks
 * between letters still; so does a run of only such punctuation.
 */
const IDEOGRAPHIC_RUN =
  /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\u{3000}-\u{303f}\u{ff00}-\u{ff9f}\u{ffe0}-\u{ffef}]+/gu;
const IDEOGRAPHIC_LETTER = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]/u;

function decodeXml(text: string): string {
  return text.replace(ENTITY, (whole, name?: string, decimal?: string, hex?: string) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    const code = decimal ? Number(decimal) : Number.parseInt(hex ?? "", 16);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function attributesOf(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const [, name, , value] of tag.matchAll(ATTRIBUTE)) {
    if (name && value !== undefined) attributes.set(name, decodeXml(value));
  }
  return attributes;
}

/** An on/off property's value: on when it has none. */
function isOn(value: string | undefined): boolean {
  return value === undefined || !/^(?:0|false|off)$/i.test(value.trim());
}

/** The wordWrap set in what holds a pPr, or undefined where it sets none. */
function wordWrapIn(xml: string): boolean | undefined {
  const properties = PARAGRAPH_PROPERTIES.exec(xml.replace(PROPERTIES_CHANGE, ""))?.[1];
  const tag = properties === undefined ? undefined : WORD_WRAP.exec(properties)?.[1];
  return tag === undefined ? undefined : isOn(attributesOf(tag).get("val"));
}

/** docx-preview's class for a style, under its `className` option. */
export function styleClassOf(className: string, styleId: string): string {
  const name = styleId.replace(/[ .]+/g, "-").replace(/&+/g, "and").toLowerCase();
  return `${className}_${name}`;
}

/**
 * Which paragraphs may break Hangul within a word, as styles.xml sets
 * it: a style's own wordWrap, else the one it is based on's, else the
 * document's default, else on, as Word takes a document that sets none.
 */
export function hangulWrapOf(stylesXml: string, className: string): HangulWrap {
  const defaults = wordWrapIn(PARAGRAPH_DEFAULTS.exec(stylesXml)?.[1] ?? "");
  const styles = new Map<string, { basedOn: string | undefined; wrap: boolean | undefined }>();
  let plainId: string | undefined;
  for (const [, head = "", inner = ""] of stylesXml.matchAll(STYLE)) {
    const attributes = attributesOf(head);
    const id = attributes.get("styleId");
    if (id === undefined || (attributes.get("type") ?? "paragraph") !== "paragraph") continue;
    const basedOn = BASED_ON.exec(inner)?.[1];
    styles.set(id, {
      basedOn: basedOn === undefined ? undefined : attributesOf(basedOn).get("val"),
      wrap: wordWrapIn(inner),
    });
    if (plainId === undefined && attributes.has("default") && isOn(attributes.get("default"))) {
      plainId = id;
    }
  }
  const own = (id: string, seen: Set<string>): boolean | undefined => {
    const style = styles.get(id);
    if (!style || seen.has(id)) return undefined;
    seen.add(id);
    return style.wrap ?? (style.basedOn === undefined ? undefined : own(style.basedOn, seen));
  };
  const allows = (id: string | undefined): boolean =>
    (id === undefined ? undefined : own(id, new Set())) ?? defaults ?? true;
  return {
    byClass: new Map(Array.from(styles.keys(), (id) => [styleClassOf(className, id), allows(id)])),
    plain: allows(plainId),
  };
}

function breaksHangul(paragraph: HTMLElement, wrap: HangulWrap): boolean {
  // docx-preview writes the paragraph's own wordWrap, when it is on, as this.
  if (paragraph.style.overflowWrap === "break-word") return true;
  for (const name of paragraph.classList) {
    const allows = wrap.byClass.get(name);
    if (allows !== undefined) return allows;
  }
  return wrap.plain;
}

/** Where the runs of Chinese or Japanese in a text start and end. */
export function ideographicRuns(text: string): [start: number, end: number][] {
  const runs: [number, number][] = [];
  for (const match of text.matchAll(IDEOGRAPHIC_RUN)) {
    if (IDEOGRAPHIC_LETTER.test(match[0])) runs.push([match.index, match.index + match[0].length]);
  }
  return runs;
}

/**
 * Keeps a text's Hangul words whole: the element it is in keeps its words,
 * but for the Chinese and Japanese in it, each run set apart in an element
 * that does not. Not a span, which docx-preview's styles for spans would
 * set in other than its run's font.
 */
function keepWords(text: Text): void {
  const parent = text.parentElement;
  if (!parent) return;
  parent.style.wordBreak = "keep-all";
  let rest = text;
  let restStart = 0;
  for (const [start, end] of ideographicRuns(text.data)) {
    const run = rest.splitText(start - restStart);
    rest = run.splitText(end - start);
    restStart = end;
    const apart = document.createElement("data");
    apart.style.wordBreak = "normal";
    run.replaceWith(apart);
    apart.append(run);
  }
}

/** Sets the Hangul of each paragraph that keeps its words to break only between them. */
export function keepHangulWords(body: HTMLElement, wrap: HangulWrap): void {
  if (wrap.plain && !Array.from(wrap.byClass.values()).includes(false)) return;
  for (const paragraph of body.querySelectorAll("p")) {
    if (breaksHangul(paragraph, wrap)) continue;
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    const hangul: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node instanceof Text && HANGUL.test(node.data)) hangul.push(node);
    }
    for (const text of hangul) keepWords(text);
  }
}

function stylesXmlOf(bytes: Uint8Array): string | null {
  try {
    const data = unzipSync(bytes, { filter: (file) => file.name === STYLES_PART })[STYLES_PART];
    return data ? strFromU8(data) : null;
  } catch {
    return null;
  }
}

/** Breaks the Hangul in `body`, docx-preview's drawing of `bytes`, where Word breaks it. */
export function wordHangulWrap(bytes: Uint8Array, body: HTMLElement, className: string): void {
  const stylesXml = stylesXmlOf(bytes);
  if (stylesXml !== null) keepHangulWords(body, hangulWrapOf(stylesXml, className));
}
