// Quick look's diff of a file the session changed: the file before the
// session's first change against the file as it is now, read-only. It
// follows the file as Claude or the editor changes it.

import { useMonaco } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fontFamily, typeScale } from "../../../shared/design-tokens";
import { MAX_READABLE_FILE_SIZE } from "../../../shared/fs/defaults";
import { useMonacoThemeName } from "../../hooks/use-monaco-theme-name";
import { isUnder } from "../../services/chat/links";
import { useSharedModel } from "../../services/editor";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { fileErrorMessage } from "../../utils/file-error";
import { languageIdForPath } from "../editor/language-id-for-path";
import { EmptyState } from "../ui/empty-state";
import { useModelSource } from "../workspace/content/editor-view";

const diffOptions = {
  readOnly: true,
  originalEditable: false,
  minimap: { enabled: false },
  fontSize: typeScale.codeBody.fontSize,
  fontFamily: fontFamily.monoBody,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderLineHighlight: "none",
} satisfies Monaco.editor.IDiffEditorConstructionOptions;

/** Numbers the diffs so each one's models get their own URIs. */
let nextDiffId = 0;

export function LookDiff({
  workspaceId,
  path,
  before,
}: {
  workspaceId: string;
  path: string;
  /** The file before the session changed it; null when the session wrote it new. */
  before: string | null;
}) {
  const { t } = useTranslation();
  const monaco = useMonaco();
  const root = useWorkspacesStore((s) => {
    const location = s.workspaces.find((w) => w.id === workspaceId)?.location;
    if (!location) return "";
    return location.kind === "local" ? location.rootPath : location.remotePath;
  });
  const { model, phase, errorCode } = useSharedModel({
    workspaceId,
    filePath: path,
    origin: isUnder(path, root) ? "workspace" : "external",
  });
  const now = useModelSource(model ?? null);

  if (phase === "error" && errorCode !== "NOT_FOUND") {
    return (
      <EmptyState
        title={fileErrorMessage(errorCode ?? "OTHER", MAX_READABLE_FILE_SIZE / (1024 * 1024))}
        tone="status"
        className="h-full"
      />
    );
  }
  if (phase === "binary") {
    return <EmptyState title={t("editor.binary_file")} tone="status" className="h-full" />;
  }
  if (!monaco || phase === "loading" || (phase === "ready" && !model)) {
    return <EmptyState title={t("editor.loading_diff")} tone="status" className="h-full" />;
  }
  // A file gone since shows as emptied.
  return <DiffHost monaco={monaco} path={path} before={before ?? ""} now={model ? now : ""} />;
}

/** Owns the diff editor and both of its models; neither is the editor's shared one. */
function DiffHost({
  monaco,
  path,
  before,
  now,
}: {
  monaco: typeof Monaco;
  path: string;
  before: string;
  now: string;
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
    const created = monaco.editor.createDiffEditor(container, { ...diffOptions, theme });
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
  }, [monaco, id, path]);

  useEffect(() => {
    monaco.editor.setTheme(theme);
  }, [monaco, theme]);

  useEffect(() => {
    const models = editor?.getModel();
    if (!models) return;
    if (models.original.getValue() !== before) models.original.setValue(before);
    if (models.modified.getValue() !== now) models.modified.setValue(now);
  }, [editor, before, now]);

  return <div ref={containerRef} className="h-full w-full" data-testid="chat-look-diff" />;
}
