import type * as Monaco from "monaco-editor";
import { useEffect, useRef, useState } from "react";
import { fontFamily, typeScale } from "../../../shared/design-tokens";
import { useMonacoThemeName } from "../../hooks/use-monaco-theme-name";
import { languageIdForPath } from "./language-id-for-path";

const diffOptions = {
  readOnly: true,
  originalEditable: false,
  renderMarginRevertIcon: false,
  renderGutterMenu: false,
  minimap: { enabled: false },
  fontSize: typeScale.codeBody.fontSize,
  fontFamily: fontFamily.monoBody,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderLineHighlight: "none",
} satisfies Monaco.editor.IDiffEditorConstructionOptions;

/** Numbers the diffs so each one's models get their own URIs. */
let nextDiffId = 0;

/** Owns the diff editor and both of its models; neither is the editor's shared one. */
export function ReadOnlyDiffEditor({
  monaco,
  path,
  before,
  now,
  testId,
  sideBySide = false,
}: {
  monaco: typeof Monaco;
  path: string;
  before: string;
  now: string;
  testId?: string;
  sideBySide?: boolean;
}) {
  const theme = useMonacoThemeName();
  const containerRef = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<Monaco.editor.IStandaloneDiffEditor | null>(null);
  const [id] = useState(() => ++nextDiffId);

  // The theme only seeds creation; the effect below follows it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const language = languageIdForPath(monaco, path) ?? "plaintext";
    const uri = (side: string) => monaco.Uri.parse(`nexus-look-diff:///${id}/${side}${path}`);
    const original = monaco.editor.createModel("", language, uri("before"));
    const modified = monaco.editor.createModel("", language, uri("now"));
    const created = monaco.editor.createDiffEditor(container, {
      ...diffOptions,
      theme,
      ...(sideBySide && { renderSideBySide: true, useInlineViewWhenSpaceIsLimited: false }),
    });
    created.setModel({ original, modified });
    setEditor(created);
    return () => {
      // Detach the models before disposing them; disposing a shown model throws.
      created.setModel(null);
      created.dispose();
      original.dispose();
      modified.dispose();
      setEditor(null);
    };
  }, [monaco, id, path, sideBySide]);

  useEffect(() => {
    monaco.editor.setTheme(theme);
  }, [monaco, theme]);

  useEffect(() => {
    const models = editor?.getModel();
    if (!models) return;
    if (models.original.getValue() !== before) models.original.setValue(before);
    if (models.modified.getValue() !== now) models.modified.setValue(now);
  }, [editor, before, now]);

  return <div ref={containerRef} className="h-full w-full" data-testid={testId} />;
}
