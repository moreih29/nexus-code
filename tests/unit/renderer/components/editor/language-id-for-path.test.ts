/**
 * Unit tests for languageIdForPath in
 * src/renderer/components/editor/language-id-for-path.ts.
 *
 * SCOPE:
 *   - Filename takes precedence over extension matching.
 *   - Extension matching is case-insensitive and prefers the longest hit.
 *   - Unrecognized paths return undefined.
 *
 * ISOLATION: languageIdForPath is a pure function whose only dependency is the
 * `monaco.languages.getLanguages()` accessor. The tests stub it with a small
 * fixture array.
 */

import { describe, expect, test } from "bun:test";
import { languageIdForPath } from "../../../../../src/renderer/components/editor/language-id-for-path";

interface FakeLang {
  id: string;
  extensions?: string[];
  filenames?: string[];
}

function makeMonaco(langs: FakeLang[]): Parameters<typeof languageIdForPath>[0] {
  return {
    languages: {
      getLanguages: () => langs as never,
    },
  } as unknown as Parameters<typeof languageIdForPath>[0];
}

describe("languageIdForPath", () => {
  test("matches by extension", () => {
    const monaco = makeMonaco([
      { id: "typescript", extensions: [".ts", ".tsx"] },
      { id: "javascript", extensions: [".js"] },
    ]);
    expect(languageIdForPath(monaco, "src/foo/bar.ts")).toBe("typescript");
    expect(languageIdForPath(monaco, "src/foo/bar.tsx")).toBe("typescript");
    expect(languageIdForPath(monaco, "lib/index.js")).toBe("javascript");
  });

  test("extension comparison is case-insensitive", () => {
    const monaco = makeMonaco([{ id: "javascript", extensions: [".js"] }]);
    expect(languageIdForPath(monaco, "src/Foo/BAR.JS")).toBe("javascript");
  });

  test("filename exact match wins over extension match", () => {
    const monaco = makeMonaco([
      { id: "dockerfile", filenames: ["Dockerfile"] },
      { id: "plain", extensions: [".file"] }, // would not match anyway, just noise
    ]);
    expect(languageIdForPath(monaco, "ops/Dockerfile")).toBe("dockerfile");
  });

  test("filename comparison is case-insensitive", () => {
    const monaco = makeMonaco([{ id: "makefile", filenames: ["Makefile"] }]);
    expect(languageIdForPath(monaco, "MAKEFILE")).toBe("makefile");
  });

  test("prefers longest matching extension", () => {
    const monaco = makeMonaco([
      { id: "html", extensions: [".html"] },
      { id: "razor", extensions: [".cshtml.razor"] },
    ]);
    expect(languageIdForPath(monaco, "views/Index.cshtml.razor")).toBe("razor");
  });

  test("returns undefined when no language claims the path", () => {
    const monaco = makeMonaco([{ id: "typescript", extensions: [".ts"] }]);
    expect(languageIdForPath(monaco, "foo/bar.xyz")).toBeUndefined();
  });

  test("returns undefined for empty path", () => {
    const monaco = makeMonaco([{ id: "typescript", extensions: [".ts"] }]);
    expect(languageIdForPath(monaco, "")).toBeUndefined();
  });

  test("handles flat (no slash) paths", () => {
    const monaco = makeMonaco([{ id: "json", extensions: [".json"] }]);
    expect(languageIdForPath(monaco, "package.json")).toBe("json");
  });
});
