export const STANDARD_DOCTYPE = "<!DOCTYPE html>";

const DOCTYPE_OPEN = "<!doctype";

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
