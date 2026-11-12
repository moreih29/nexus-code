// Language-id resolver used by the diff editor.
//
// Without any of the `originalLanguage` / `modifiedLanguage` / `language` props,
// `@monaco-editor/react`'s `DiffEditor` always hardcodes `'text'` and calls
// `monaco.editor.createModel(value, 'text', uri)`
// (`getOrCreateModel` in suren-atoyan/monaco-react `src/utils/index.ts`).
// As a result Monaco's `createTextModel` never enters the `!languageId` branch, so
// URI-based auto-detection (`languagesAssociations.ts`) does not run at all.
//
// So path → languageId has to be resolved here and passed down as a prop.
// The regular `Editor` (`editor-view.tsx`) creates its model in `entry.ts` with
// `createModel(value, undefined, monacoUri)`, so auto-detection works and the same
// path is not needed.
//
// Match priority is the same as Monaco's internal `getAssociationByPath`:
//   1. exact filename match (case-insensitive)
//   2. longest extension match (case-insensitive, `endsWith`)
// `filenamePatterns` (glob) matching is left out on purpose — no language registered by
// basic-languages depends on a glob alone, and mimicking glob matching exactly would mean
// pulling in vscode's `match.ts`.

import type * as Monaco from "monaco-editor";

/**
 * Returns the Monaco language id that should be used for `relPath`, or
 * `undefined` when no registered language claims it. Callers should fall back
 * to `"plaintext"` (Monaco's own default for unrecognized files).
 */
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
