import { describe, expect, mock, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import { color } from "../../../../src/shared/design-tokens";

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

mock.module("../../../../src/renderer/ipc/client", () => ({
  ipcCall: mock(() => Promise.resolve(undefined)),
  ipcListen: mock(() => () => {}),
}));

const { initializeEditorServices } = await import("../../../../src/renderer/services/editor");
const { initializeMonacoTheme, NEXUS_DARK_THEME_NAME } = await import(
  "../../../../src/renderer/services/editor/monaco-theme"
);

interface ThemeCall {
  name: string;
  theme: Monaco.editor.IStandaloneThemeData;
}

function createFakeMonaco(): typeof Monaco & {
  __defineTheme: (name: string, theme: Monaco.editor.IStandaloneThemeData) => void;
  __themeCalls: ThemeCall[];
} {
  const themeCalls: ThemeCall[] = [];
  const defineTheme = mock((name: string, theme: Monaco.editor.IStandaloneThemeData) => {
    themeCalls.push({ name, theme });
  });

  return {
    Uri: {
      parse: (raw: string) => ({ toString: () => raw }) as Monaco.Uri,
    },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    MarkerTag: { Unnecessary: 1, Deprecated: 2 },
    editor: {
      defineTheme,
      getModel: () => null,
      setModelMarkers: () => {},
    },
    languages: {
      CompletionItemKind: { Text: 1 },
      registerHoverProvider: () => ({ dispose: () => {} }),
      registerDefinitionProvider: () => ({ dispose: () => {} }),
      registerCompletionItemProvider: () => ({ dispose: () => {} }),
      registerReferenceProvider: () => ({ dispose: () => {} }),
      registerDocumentHighlightProvider: () => ({ dispose: () => {} }),
      registerDocumentSymbolProvider: () => ({ dispose: () => {} }),
    },
    __defineTheme: defineTheme,
    __themeCalls: themeCalls,
  } as unknown as typeof Monaco & {
    __defineTheme: (name: string, theme: Monaco.editor.IStandaloneThemeData) => void;
    __themeCalls: ThemeCall[];
  };
}

describe("nexus-dark Monaco theme", () => {
  test("defines warm word-highlight colors once per Monaco instance", () => {
    const monaco = createFakeMonaco();

    initializeMonacoTheme(monaco);
    initializeMonacoTheme(monaco);

    expect(monaco.__defineTheme).toHaveBeenCalledTimes(1);
    expect(monaco.__themeCalls).toHaveLength(1);
    expect(monaco.__themeCalls[0]?.name).toBe(NEXUS_DARK_THEME_NAME);
    expect(monaco.__themeCalls[0]?.theme).toMatchObject({
      base: "vs-dark",
      inherit: true,
      rules: [],
    });
    expect(monaco.__themeCalls[0]?.theme.colors).toEqual({
      "editor.wordHighlightBackground": color.editorWordHighlight,
      "editor.wordHighlightStrongBackground": color.editorWordHighlightStrong,
      "editor.wordHighlightTextBackground": color.editorWordHighlightText,
    });
  });

  test("initializeEditorServices initializes the theme once", () => {
    const monaco = createFakeMonaco();

    initializeEditorServices(monaco);
    initializeEditorServices(monaco);

    expect(monaco.__defineTheme).toHaveBeenCalledTimes(1);
    expect(monaco.__themeCalls.map((call) => call.name)).toEqual([NEXUS_DARK_THEME_NAME]);
  });
});
