// Font files, which the editor shows set in sample text rather than opens
// in Monaco.

/** What the browser loads as a web font: TrueType, OpenType and WOFF. */
const FONT_EXTENSIONS = [".ttf", ".otf", ".woff", ".woff2"];

export function isFontFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return FONT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
