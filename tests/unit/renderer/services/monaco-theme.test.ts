import { describe, expect, mock, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import { nexusDarkPalette } from "../../../../src/shared/editor-palette";

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
const { initializeMonacoTheme, NEXUS_DARK_THEME_NAME, buildEditorColors } = await import(
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

describe("nexus-dark Monaco theme — two distinct instances are tracked independently", () => {
  test("each instance gets defineTheme called exactly once, regardless of the other", () => {
    const monacoA = createFakeMonaco();
    const monacoB = createFakeMonaco();

    // First instance: two calls → only first registers
    initializeMonacoTheme(monacoA);
    initializeMonacoTheme(monacoA);

    // Second instance: first call should register (not share WeakSet entry with A)
    initializeMonacoTheme(monacoB);

    expect(monacoA.__defineTheme).toHaveBeenCalledTimes(1);
    expect(monacoB.__defineTheme).toHaveBeenCalledTimes(1);
  });

  test("buildEditorColors reference values match editor palette exactly", () => {
    const colors = buildEditorColors(nexusDarkPalette);
    expect(colors["editor.wordHighlightBackground"]).toBe(nexusDarkPalette.wordHighlightBackground);
    expect(colors["editor.wordHighlightStrongBackground"]).toBe(
      nexusDarkPalette.wordHighlightStrongBackground,
    );
    expect(colors["editor.wordHighlightTextBackground"]).toBe(
      nexusDarkPalette.wordHighlightTextBackground,
    );
  });
});

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
    expect(monaco.__themeCalls[0]?.theme.colors).toMatchObject({
      "editor.wordHighlightBackground": nexusDarkPalette.wordHighlightBackground,
      "editor.wordHighlightStrongBackground": nexusDarkPalette.wordHighlightStrongBackground,
      "editor.wordHighlightTextBackground": nexusDarkPalette.wordHighlightTextBackground,
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

describe("buildEditorColors — mapper", () => {
  test("1:1 palette key preservation — no derivation", () => {
    const altPalette = {
      wordHighlightBackground: "test:wordHighlightBackground",
      wordHighlightStrongBackground: "test:wordHighlightStrongBackground",
      wordHighlightTextBackground: "test:wordHighlightTextBackground",
      findRangeHighlightBackground: "test:findRangeHighlightBackground",
      findMatchHighlightBackground: "test:findMatchHighlightBackground",
      findMatchBackground: "test:findMatchBackground",
      peekViewBorder: "test:peekViewBorder",
      peekViewEditorMatchHighlightBackground: "test:peekViewEditorMatchHighlightBackground",
      peekViewResultMatchHighlightBackground: "test:peekViewResultMatchHighlightBackground",
      peekViewResultBackground: "test:peekViewResultBackground",
      linkForeground: "test:linkForeground",
      linkActiveForeground: "test:linkActiveForeground",
      selectionBackground: "test:selectionBackground",
      inactiveSelectionBackground: "test:inactiveSelectionBackground",
      selectionHighlightBackground: "test:selectionHighlightBackground",
      hoverWidgetBackground: "test:hoverWidgetBackground",
      hoverWidgetBorder: "test:hoverWidgetBorder",
      editorWidgetBackground: "test:editorWidgetBackground",
      editorWidgetBorder: "test:editorWidgetBorder",
      errorForeground: "test:errorForeground",
      warningForeground: "test:warningForeground",
      infoForeground: "test:infoForeground",
      hintForeground: "test:hintForeground",
      errorBackground: "test:errorBackground",
      warningBackground: "test:warningBackground",
      infoBackground: "test:infoBackground",
      hintBackground: "test:hintBackground",
    };

    const result = buildEditorColors(altPalette);

    expect(result["editor.wordHighlightBackground"]).toBe(altPalette.wordHighlightBackground);
    expect(result["editor.wordHighlightStrongBackground"]).toBe(
      altPalette.wordHighlightStrongBackground,
    );
    expect(result["editor.wordHighlightTextBackground"]).toBe(
      altPalette.wordHighlightTextBackground,
    );
    expect(result["editor.findRangeHighlightBackground"]).toBe(
      altPalette.findRangeHighlightBackground,
    );
    expect(result["editor.findMatchHighlightBackground"]).toBe(
      altPalette.findMatchHighlightBackground,
    );
    expect(result["editor.findMatchBackground"]).toBe(altPalette.findMatchBackground);
    expect(result["peekView.border"]).toBe(altPalette.peekViewBorder);
    expect(result["peekViewEditor.matchHighlightBackground"]).toBe(
      altPalette.peekViewEditorMatchHighlightBackground,
    );
    expect(result["peekViewResult.matchHighlightBackground"]).toBe(
      altPalette.peekViewResultMatchHighlightBackground,
    );
    expect(result["peekViewResult.background"]).toBe(altPalette.peekViewResultBackground);
    expect(result["editorLink.activeForeground"]).toBe(altPalette.linkActiveForeground);
    expect(result["editor.selectionBackground"]).toBe(altPalette.selectionBackground);
    expect(result["editor.inactiveSelectionBackground"]).toBe(
      altPalette.inactiveSelectionBackground,
    );
    expect(result["editor.selectionHighlightBackground"]).toBe(
      altPalette.selectionHighlightBackground,
    );
    expect(result["editorHoverWidget.background"]).toBe(altPalette.hoverWidgetBackground);
    expect(result["editorHoverWidget.border"]).toBe(altPalette.hoverWidgetBorder);
    expect(result["editorWidget.background"]).toBe(altPalette.editorWidgetBackground);
    expect(result["editorWidget.border"]).toBe(altPalette.editorWidgetBorder);
    expect(result["editorError.foreground"]).toBe(altPalette.errorForeground);
    expect(result["editorWarning.foreground"]).toBe(altPalette.warningForeground);
    expect(result["editorInfo.foreground"]).toBe(altPalette.infoForeground);
    expect(result["editorHint.foreground"]).toBe(altPalette.hintForeground);
    expect(result["editorError.background"]).toBe(altPalette.errorBackground);
    expect(result["editorWarning.background"]).toBe(altPalette.warningBackground);
    expect(result["editorInfo.background"]).toBe(altPalette.infoBackground);
    expect(result["editorHint.background"]).toBe(altPalette.hintBackground);
  });

  test("monaco token coverage — all expected keys present", () => {
    const result = buildEditorColors(nexusDarkPalette);
    const expectedKeys = [
      "editor.findMatchBackground",
      "editor.findMatchHighlightBackground",
      "editor.findRangeHighlightBackground",
      "editor.inactiveSelectionBackground",
      "editor.selectionBackground",
      "editor.selectionHighlightBackground",
      "editor.wordHighlightBackground",
      "editor.wordHighlightStrongBackground",
      "editor.wordHighlightTextBackground",
      "editorError.background",
      "editorError.foreground",
      "editorHint.background",
      "editorHint.foreground",
      "editorHoverWidget.background",
      "editorHoverWidget.border",
      "editorInfo.background",
      "editorInfo.foreground",
      "editorLink.activeForeground",
      "editorWarning.background",
      "editorWarning.foreground",
      "editorWidget.background",
      "editorWidget.border",
      "peekView.border",
      "peekViewEditor.matchHighlightBackground",
      "peekViewResult.background",
      "peekViewResult.matchHighlightBackground",
    ];
    expect(Object.keys(result).sort()).toEqual(expectedKeys.sort());
  });

  test("values from real dark palette match nexusDarkPalette", () => {
    const result = buildEditorColors(nexusDarkPalette);

    expect(result["editor.findMatchBackground"]).toBe(nexusDarkPalette.findMatchBackground);
    expect(result["peekView.border"]).toBe(nexusDarkPalette.peekViewBorder);
    expect(result["editorLink.activeForeground"]).toBe(nexusDarkPalette.linkActiveForeground);
    expect(result["editor.selectionBackground"]).toBe(nexusDarkPalette.selectionBackground);
    expect(result["editorError.foreground"]).toBe(nexusDarkPalette.errorForeground);
    expect(result["editorHoverWidget.background"]).toBe(nexusDarkPalette.hoverWidgetBackground);
  });
});
