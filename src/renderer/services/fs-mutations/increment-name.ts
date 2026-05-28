/**
 * incrementFileName — VSCode-parity "copy" suffix generator for paste/copy
 * collisions. Port of the `'simple'` branch of VSCode's `incrementFileName`
 * (src/vs/workbench/contrib/files/browser/fileActions.ts).
 *
 *   analysis.html        → analysis copy.html
 *   analysis copy.html   → analysis copy 2.html
 *   analysis copy 2.html → analysis copy 3.html
 *   src (folder)         → src copy
 *
 * The extension is preserved for files (split on the last dot, except a
 * leading dot which marks a dotfile with no extension). Folders are never
 * split, so a dot in a folder name stays part of the name.
 */

const COPY_SUFFIX_RE = /^(.+ copy)( \d+)?$/;

function splitStemExt(name: string, isFolder: boolean): { stem: string; ext: string } {
  if (isFolder) return { stem: name, ext: "" };
  const dot = name.lastIndexOf(".");
  // dot <= 0 → no dot, or a leading-dot dotfile (".gitignore") → treat whole
  // string as the stem so it becomes ".gitignore copy".
  if (dot <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

export function incrementFileName(name: string, isFolder = false): string {
  const { stem, ext } = splitStemExt(name, isFolder);

  // "name copy" → "name copy 2"; "name copy 5" → "name copy 6".
  if (COPY_SUFFIX_RE.test(stem)) {
    return (
      stem.replace(COPY_SUFFIX_RE, (_m, g1: string, g2?: string) => {
        const n = g2 ? parseInt(g2, 10) : 1;
        return `${g1} ${n + 1}`;
      }) + ext
    );
  }

  // "name" → "name copy".
  return `${stem} copy${ext}`;
}
