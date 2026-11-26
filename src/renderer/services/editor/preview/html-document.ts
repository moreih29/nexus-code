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
  const at = doctypeEnd === -1 ? STANDARD_DOCTYPE.length : doctypeEnd;
  return html.slice(0, at) + head + html.slice(at);
}

const LINK_TAG = /<link\b[^>]*>/gi;
const META_TAG = /<meta\b[^>]*>/gi;
const BASE_TAG = /<base\b[^>]*>/gi;

function attributeOf(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function keepsLink(tag: string): boolean {
  const rel = (attributeOf(tag, "rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return (
    rel.includes("stylesheet") &&
    rel.every((token) => token === "stylesheet" || token === "alternate")
  );
}

export function previewSafeHtml(source: string): string {
  return source
    .replace(LINK_TAG, (tag) => (keepsLink(tag) ? tag : ""))
    .replace(META_TAG, (tag) =>
      (attributeOf(tag, "http-equiv") ?? "").toLowerCase() === "refresh" ? "" : tag,
    )
    .replace(BASE_TAG, "");
}
