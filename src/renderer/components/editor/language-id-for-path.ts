// Language-id resolver used by the diff editor.
//
// `@monaco-editor/react`의 `DiffEditor`는 `originalLanguage` / `modifiedLanguage`
// / `language` prop이 모두 없을 때 항상 `'text'`로 하드코딩한 채
// `monaco.editor.createModel(value, 'text', uri)`를 호출한다
// (suren-atoyan/monaco-react `src/utils/index.ts` 의 `getOrCreateModel`).
// 그 결과 Monaco의 `createTextModel`이 `!languageId` 분기로 들어가지 못해
// URI 기반 자동 감지(`languagesAssociations.ts`)가 전혀 동작하지 않는다.
//
// 그래서 우리가 직접 path → languageId를 풀어주고 prop으로 흘려야 한다.
// 일반 `Editor`(`editor-view.tsx`)는 우리 쪽 `entry.ts`에서 `createModel(value,
// undefined, monacoUri)`로 만들기 때문에 자동 감지가 정상 동작하므로 동일
// 경로가 필요하지 않다.
//
// 매칭 우선순위는 Monaco 내부 `getAssociationByPath`와 같다:
//   1. 정확한 filename 일치 (대소문자 무시)
//   2. 가장 긴 extension 일치 (대소문자 무시, `endsWith`)
// `filenamePatterns`(glob) 매칭은 의도적으로 생략한다 — basic-languages가
// 등록하는 어떤 언어도 glob에만 의존하지 않으며, glob 매칭을 정확히 모사하려면
// vscode의 `match.ts`를 끌어와야 한다.

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
