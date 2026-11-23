const FONT_EXTENSIONS = [".ttf", ".otf", ".woff", ".woff2"];

export function isFontFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return FONT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
