/**
 * A small XML reader for the parts of an Office file: a stream of element
 * starts, ends and text, as the file has them. Names lose their namespace
 * prefix; attribute names keep theirs. Entities are decoded, CDATA is
 * text, and the declaration, comments and processing instructions are
 * skipped. It does not check that the XML is well formed.
 */

export interface XmlHandlers {
  start?(name: string, attrs: Readonly<Record<string, string>>, empty: boolean): void;
  end?(name: string): void;
  text?(text: string): void;
}

export function scanXml(xml: string, on: XmlHandlers): void {
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      on.text?.(decodeEntities(xml.slice(i)));
      return;
    }
    if (lt > i) on.text?.(decodeEntities(xml.slice(i, lt)));
    if (xml.startsWith("<![CDATA[", lt)) {
      const close = endOf(xml, "]]>", lt);
      on.text?.(xml.slice(lt + 9, close));
      i = close + 3;
      continue;
    }
    if (xml.startsWith("<!--", lt)) {
      i = endOf(xml, "-->", lt) + 3;
      continue;
    }
    if (xml[lt + 1] === "?" || xml[lt + 1] === "!") {
      i = endOf(xml, ">", lt) + 1;
      continue;
    }
    const gt = tagEnd(xml, lt);
    const tag = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (tag.startsWith("/")) {
      on.end?.(localName(tag.slice(1).trim()));
      continue;
    }
    const empty = tag.endsWith("/");
    const body = empty ? tag.slice(0, -1) : tag;
    const nameEnd = body.search(/[\s/]|$/);
    const name = localName(body.slice(0, nameEnd));
    on.start?.(name, attributes(body.slice(nameEnd)), empty);
    if (empty) on.end?.(name);
  }
}

/** Where `token` starts after `from`, or the end of `xml` when it never does. */
function endOf(xml: string, token: string, from: number): number {
  const at = xml.indexOf(token, from);
  return at === -1 ? xml.length : at;
}

/** The `>` closing the tag at `lt`, past any in quoted attribute values. */
function tagEnd(xml: string, lt: number): number {
  let quote = "";
  for (let i = lt + 1; i < xml.length; i++) {
    const c = xml[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i;
  }
  return xml.length;
}

function localName(name: string): string {
  return name.slice(name.indexOf(":") + 1);
}

const ATTRIBUTE = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of text.matchAll(ATTRIBUTE)) {
    attrs[m[1] as string] = decodeEntities(m[2] ?? m[3] ?? "");
  }
  return attrs;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref.startsWith("#")) {
      const code =
        ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ref] ?? whole;
  });
}
