import type * as Monaco from "monaco-editor";
import { color } from "../../../shared/design-tokens";

export const NEXUS_DARK_THEME_NAME = "nexus-dark";

export const NEXUS_DARK_THEME_COLORS = {
  "editor.wordHighlightBackground": color.editorWordHighlight,
  "editor.wordHighlightStrongBackground": color.editorWordHighlightStrong,
  "editor.wordHighlightTextBackground": color.editorWordHighlightText,
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
