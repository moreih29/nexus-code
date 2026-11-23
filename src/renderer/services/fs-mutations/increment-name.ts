const COPY_SUFFIX_RE = /^(.+ copy)( \d+)?$/;

function splitStemExt(name: string, isFolder: boolean): { stem: string; ext: string } {
  if (isFolder) return { stem: name, ext: "" };
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

export function incrementFileName(name: string, isFolder = false): string {
  const { stem, ext } = splitStemExt(name, isFolder);

  if (COPY_SUFFIX_RE.test(stem)) {
    return (
      stem.replace(COPY_SUFFIX_RE, (_m, g1: string, g2?: string) => {
        const n = g2 ? parseInt(g2, 10) : 1;
        return `${g1} ${n + 1}`;
      }) + ext
    );
  }

  return `${stem} copy${ext}`;
}
