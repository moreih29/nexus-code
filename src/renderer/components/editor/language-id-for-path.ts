import type * as Monaco from "monaco-editor";

export function languageIdForPath(
  monaco: Pick<typeof Monaco, "languages">,
  relPath: string,
): string | undefined {
  const segments = relPath.split("/");
  const filename = (segments[segments.length - 1] ?? relPath).toLowerCase();
  if (!filename) return undefined;

  let bestId: string | undefined;
  let bestExtLen = 0;

  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((name) => name.toLowerCase() === filename)) {
      return lang.id;
    }
    if (lang.extensions) {
      for (const ext of lang.extensions) {
        const lowered = ext.toLowerCase();
        if (filename.endsWith(lowered) && lowered.length > bestExtLen) {
          bestId = lang.id;
          bestExtLen = lowered.length;
        }
      }
    }
  }
  return bestId;
}
