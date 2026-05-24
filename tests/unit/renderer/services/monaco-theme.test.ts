import { describe, expect, mock, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import { EDITOR_PALETTES } from "../../../../src/shared/editor/palette";

// Anchor the test against a single representative dark palette. The previous
// `nexusDarkPalette` export was retired when the adapter-based theme system
// replaced the inline palette constants — every palette is now derived from
// theme-sources.ts. github-dark is the new default theme (DEFAULT_THEME).
const nexusDarkPalette = EDITOR_PALETTES["github-dark"];

// Stub document.documentElement before importing the monaco-theme module.
// subscribeMonacoThemeChanges (called by initializeMonacoTheme) attaches a
// listener to document.documentElement; without the stub the module throws
// ReferenceError: document is not defined in a bun test environment.
const listeners: Record<string, EventListenerOrEventListenerObject[]> = {};
const fakeDocumentElement = {
  addEventListener: (type: string, handler: EventListenerOrEventListenerObject) => {
    if (!listeners[type]) listeners[type] = [];
    listeners[type].push(handler);
  },
  removeEventListener: (type: string, handler: EventListenerOrEventListenerObject) => {
    if (listeners[type]) {
      listeners[type] = listeners[type].filter((h) => h !== handler);
    }
  },
};
(globalThis as Record<string, unknown>).document = {
  documentElement: fakeDocumentElement,
};

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

const realIpcClient = await import("../../../../src/renderer/ipc/client");
mock.module("../../../../src/renderer/ipc/client", () => ({
  ...realIpcClient,
  ipcCallResult: mock(() => Promise.resolve({ ok: true as const, value: undefined })),
  ipcListen: mock(() => () => {}),
  ipcStream: mock(() => ({ cancel: () => {} })),
  canUseIpcBridge: () => false,
}));

const { initializeEditorServices } = await import("../../../../src/renderer/services/editor");
const { initializeMonacoTheme, NEXUS_THEME_NAMES, buildEditorColors } = await import(
  "../../../../src/renderer/services/editor/runtime/monaco-theme"
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
      setTheme: mock(() => {}),
      getModel: () => null,
      getModelMarkers: () => [],
      setModelMarkers: () => {},
      onDidChangeMarkers: () => ({ dispose: () => {} }),
    },
    languages: {
      CompletionItemKind: { Text: 1 },
      registerHoverProvider: () => ({ dispose: () => {} }),
      registerDefinitionProvider: () => ({ dispose: () => {} }),
      registerCompletionItemProvider: () => ({ dispose: () => {} }),
      registerReferenceProvider: () => ({ dispose: () => {} }),
      registerDocumentHighlightProvider: () => ({ dispose: () => {} }),
      registerDocumentSymbolProvider: () => ({ dispose: () => {} }),
      registerDocumentSemanticTokensProvider: () => ({ dispose: () => {} }),
      // Stubs required by registerExtraLanguages (extra-languages.ts) so the
      // initializeEditorServices call inside theme tests doesn't throw on a
      // missing fake. The theme tests don't assert on these — they exist
      // only to keep the call chain alive.
      register: () => {},
      setMonarchTokensProvider: () => ({ dispose: () => {} }),
      setTokensProvider: () => ({ dispose: () => {} }),
    },
    __defineTheme: defineTheme,
    __themeCalls: themeCalls,
  } as unknown as typeof Monaco & {
    __defineTheme: (name: string, theme: Monaco.editor.IStandaloneThemeData) => void;
    __themeCalls: ThemeCall[];
  };
}

describe("nexus Monaco themes — two distinct instances are tracked independently", () => {
  test("each instance gets defineTheme called once per registered theme, regardless of the other", () => {
    const monacoA = createFakeMonaco();
    const monacoB = createFakeMonaco();

    // First instance: two calls → only first registers (WeakSet guard)
    initializeMonacoTheme(monacoA);
    initializeMonacoTheme(monacoA);

    // Second instance: first call should register (not share WeakSet entry with A)
    initializeMonacoTheme(monacoB);

    // initializeMonacoTheme registers every ThemeId once per instance.
    const themeCount = Object.keys(NEXUS_THEME_NAMES).length;
    expect(monacoA.__defineTheme).toHaveBeenCalledTimes(themeCount);
    expect(monacoB.__defineTheme).toHaveBeenCalledTimes(themeCount);
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

describe("nexus Monaco themes", () => {
  test("defines github-dark word-highlight colors once per Monaco instance", () => {
    const monaco = createFakeMonaco();

    initializeMonacoTheme(monaco);
    initializeMonacoTheme(monaco);

    // Every registered theme is defined exactly once; second call is no-op.
    const themeCount = Object.keys(NEXUS_THEME_NAMES).length;
    expect(monaco.__defineTheme).toHaveBeenCalledTimes(themeCount);
    expect(monaco.__themeCalls).toHaveLength(themeCount);

    // Verify the default theme (github-dark) is registered with expected shape.
    const githubDarkCall = monaco.__themeCalls.find(
      (c) => c.name === NEXUS_THEME_NAMES["github-dark"],
    );
    expect(githubDarkCall).toBeDefined();
    expect(githubDarkCall?.theme).toMatchObject({
      base: "vs-dark",
      inherit: true,
    });
    // design.md §15.1: syntax colors are authored from the Nexus palette —
    // the old inherited `rules: []` is deprecated. rules must be populated.
    expect(githubDarkCall?.theme.rules.length).toBeGreaterThan(0);
    expect(githubDarkCall?.theme.rules).toContainEqual({
      token: "keyword",
      foreground: nexusDarkPalette.syntaxKeyword.replace(/^#/, ""),
    });
    expect(githubDarkCall?.theme.colors).toMatchObject({
      "editor.wordHighlightBackground": nexusDarkPalette.wordHighlightBackground,
      "editor.wordHighlightStrongBackground": nexusDarkPalette.wordHighlightStrongBackground,
      "editor.wordHighlightTextBackground": nexusDarkPalette.wordHighlightTextBackground,
    });
  });

  test("initializeEditorServices initializes every theme once (no duplicates)", () => {
    const monaco = createFakeMonaco();

    initializeEditorServices(monaco);
    initializeEditorServices(monaco);

    const themeCount = Object.keys(NEXUS_THEME_NAMES).length;
    expect(monaco.__defineTheme).toHaveBeenCalledTimes(themeCount);
    const registeredNames = monaco.__themeCalls.map((call) => call.name);
    for (const expectedName of Object.values(NEXUS_THEME_NAMES)) {
      expect(registeredNames).toContain(expectedName);
    }
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
      editorBackground: "test:editorBackground",
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
      "editor.background",
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
      "editorGutter.background",
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

  // Monaco standalone's defineTheme color parser silently rejects rgba()/rgb()/
  // hsl()/named-color forms and falls back to a #ff0000 sentinel. The first
  // Plan #22 ship leaked rgba() values through and produced visible bright-red
  // find/peek/selection highlights. Lock down the format so the regression
  // can't sneak back in.
  test("nexusDarkPalette values are hex-only (monaco accepts only #rrggbb / #rrggbbaa)", () => {
    const hexPattern = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
    for (const [key, value] of Object.entries(nexusDarkPalette)) {
      expect({ key, value, matches: hexPattern.test(value) }).toEqual({
        key,
        value,
        matches: true,
      });
    }
  });
});
