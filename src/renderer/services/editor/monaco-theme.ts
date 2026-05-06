import type * as Monaco from "monaco-editor";

export const NEXUS_DARK_THEME_NAME = "nexus-dark";

export const NEXUS_DARK_THEME_COLORS = {
  "editor.wordHighlightBackground": "rgba(250,249,246,0.06)",
  "editor.wordHighlightStrongBackground": "rgba(250,249,246,0.12)",
  "editor.wordHighlightTextBackground": "rgba(250,249,246,0.04)",
} satisfies Monaco.editor.IColors;

const initializedThemeMonacos = new WeakSet<object>();

export function initializeMonacoTheme(monaco: typeof Monaco): void {
  if (initializedThemeMonacos.has(monaco)) return;

  monaco.editor.defineTheme(NEXUS_DARK_THEME_NAME, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: NEXUS_DARK_THEME_COLORS,
  });
  initializedThemeMonacos.add(monaco);
}
