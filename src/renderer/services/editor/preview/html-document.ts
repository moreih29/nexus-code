// The document the HTML preview serves for a page (nexus-preview://, see
// main's custom-protocols/nexus-preview.ts): the page's source with the
// preview's own tags at the top of its head.

/** The DOCTYPE a page that names none is given. */
export const STANDARD_DOCTYPE = "<!DOCTYPE html>";

const DOCTYPE_OPEN = "<!doctype";

/**
 * Where the DOCTYPE that opens `html` ends, past its ">", after whitespace
 * and comments before it; -1 when none opens it.
 */
export function leadingDoctypeEnd(html: string): number {
  let i = 0;
  for (;;) {
    while (i < html.length && /\s/.test(html.charAt(i))) i++;
    if (html.startsWith("<!--", i)) {
      const close = html.indexOf("-->", i + 4);
      if (close === -1) return -1;
      i = close + 3;
      continue;
    }
    if (html.slice(i, i + DOCTYPE_OPEN.length).toLowerCase() !== DOCTYPE_OPEN) return -1;
    const end = html.indexOf(">", i);
    return end === -1 ? -1 : end + 1;
  }
}

/**
 * `source` with `head` placed first in its head: right after its `<head>`
 * tag, or after its DOCTYPE when it has no such tag (the parser then opens
 * the head for the tags it meets first).
 *
 * A page that names no DOCTYPE gets the standard one. The preview used to
 * give pages to the iframe as srcdoc, and the parser renders an iframe srcdoc
 * document in no-quirks mode whatever it names; a page served from an address
 * without a DOCTYPE would be laid out in quirks mode instead.
 */
export function buildPreviewDocument(source: string, head: string): string {
  const doctypeEnd = leadingDoctypeEnd(source);
  const html = doctypeEnd === -1 ? STANDARD_DOCTYPE + source : source;
  const headOpen = /<head\b[^>]*>/i.exec(html);
  const at = headOpen
    ? headOpen.index + headOpen[0].length
    : doctypeEnd === -1
      ? STANDARD_DOCTYPE.length
      : doctypeEnd;
  return html.slice(0, at) + head + html.slice(at);
}
