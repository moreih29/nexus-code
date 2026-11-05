// Quick look: a file the conversation names, shown over the Claude tab in
// the app's previews, with the session's other results a step away.
// ‹ › and ← → step through them, ↗ opens the file as a tab, esc closes.

import Editor from "@monaco-editor/react";
import { ChevronLeft, ChevronRight, FolderOpen, SquareArrowOutUpRight, X } from "lucide-react";
import type * as Monaco from "monaco-editor";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fontFamily, typeScale } from "../../../shared/design-tokens";
import { MAX_READABLE_FILE_SIZE } from "../../../shared/fs/defaults";
import { useMonacoThemeName } from "../../hooks/use-monaco-theme-name";
import { ipcCallResult } from "../../ipc/client";
import { baseName, isUnder } from "../../services/chat/links";
import { useSharedModel } from "../../services/editor";
import { isDocxFile } from "../../services/editor/preview/docx";
import { isFontFile } from "../../services/editor/preview/font";
import { mediaKindFor } from "../../services/editor/preview/media";
import { isPdfFile } from "../../services/editor/preview/pdf";
import { isPresentationFile } from "../../services/editor/preview/pptx";
import {
  defaultViewMode,
  isImageFile,
  isPreviewable,
  type ViewMode,
} from "../../services/editor/preview/previewable";
import { isSpreadsheetFile } from "../../services/editor/preview/spreadsheet";
import { usePreviewDefaultsStore } from "../../state/stores/preview-defaults";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { fileErrorMessage } from "../../utils/file-error";
import { revealInOSLabel } from "../../utils/reveal-label";
import { ImagePreview } from "../editor/preview/image-preview";
import { PreviewFindScope } from "../editor/preview/preview-find";
import { ViewModeToggle } from "../editor/preview/view-mode-toggle";
import { EmptyState } from "../ui/empty-state";
import { DocxEditorView } from "../workspace/content/docx-editor-view";
import { useSharedModelAttach } from "../workspace/content/editor-mount/use-shared-model-attach";
import { PreviewPane, useModelSource } from "../workspace/content/editor-view";
import { FontEditorView } from "../workspace/content/font-editor-view";
import { MediaEditorView } from "../workspace/content/media-editor-view";
import { PdfEditorView } from "../workspace/content/pdf-editor-view";
import { PptxEditorView } from "../workspace/content/pptx-editor-view";
import { SpreadsheetEditorView } from "../workspace/content/spreadsheet-editor-view";
import { FileKindIcon } from "./file-kind-icon";

export interface QuickLookList {
  /** Absolute paths: the session's results, or the one file opened. */
  files: string[];
  index: number;
}

interface QuickLookProps {
  workspaceId: string;
  list: QuickLookList;
  onIndex: (index: number) => void;
  onClose: () => void;
  /** Opens the file as a tab of its own. */
  onOpenTab: (path: string) => void;
  /** Whether the workspace is on this machine, where Finder can show a file. */
  local: boolean;
}

export function QuickLook({
  workspaceId,
  list,
  onIndex,
  onClose,
  onOpenTab,
  local,
}: QuickLookProps) {
  const { t } = useTranslation();
  const { files, index } = list;
  const path = files[index] ?? "";
  const count = files.length;
  const step = (by: number) => count > 1 && onIndex((index + by + count) % count);

  const viewDefaults = usePreviewDefaultsStore((s) => s.byFormat);
  const support = isPreviewable(path);
  const textual = isText(path);
  const [mode, setMode] = useState<ViewMode>(() => defaultViewMode(path, viewDefaults));
  const [modeFor, setModeFor] = useState(path);
  if (modeFor !== path) {
    setModeFor(path);
    setMode(defaultViewMode(path, viewDefaults));
  }

  // The keys go to the overlay while it is open; the focus goes back after.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    rootRef.current?.focus();
    return () => before?.focus?.();
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    // Where the arrows move a caret, they are left to it.
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true'], .monaco-editor")) return;
    event.preventDefault();
    step(event.key === "ArrowRight" ? 1 : -1);
  };

  const icon =
    "inline-flex size-6 shrink-0 items-center justify-center rounded-(--radius-control) text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("chat.look.aria", { name: baseName(path) })}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="absolute inset-0 z-40 flex flex-col bg-background outline-none"
      data-testid="chat-quick-look"
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <button
          type="button"
          className={icon}
          onClick={() => step(-1)}
          disabled={count < 2}
          aria-label={t("chat.look.previous")}
          title={t("chat.look.previous")}
        >
          <ChevronLeft className="size-4" />
        </button>
        <button
          type="button"
          className={icon}
          onClick={() => step(1)}
          disabled={count < 2}
          aria-label={t("chat.look.next")}
          title={t("chat.look.next")}
        >
          <ChevronRight className="size-4" />
        </button>
        {count > 1 && (
          <span className="shrink-0 px-1 text-app-micro tabular-nums text-muted-foreground">
            {index + 1} / {count}
          </span>
        )}
        <FileKindIcon path={path} className="ml-1 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-app-ui-sm" title={path}>
          {baseName(path)}
        </span>
        {textual && support !== "none" && (
          <ViewModeToggle
            mode={mode}
            onChange={setMode}
            disabled={support === "mdx-disabled"}
            disabledReason={support === "mdx-disabled" ? t("editor.mdx_disabled") : undefined}
          />
        )}
        {local && (
          <button
            type="button"
            className={icon}
            onClick={() => void ipcCallResult("system", "revealInOS", { absPath: path })}
            aria-label={revealInOSLabel()}
            title={revealInOSLabel()}
          >
            <FolderOpen className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          className={icon}
          onClick={() => onOpenTab(path)}
          aria-label={t("chat.look.open_tab")}
          title={t("chat.look.open_tab")}
          data-testid="chat-quick-look-open"
        >
          <SquareArrowOutUpRight className="size-3.5" />
        </button>
        <button
          type="button"
          className={icon}
          onClick={onClose}
          aria-label={t("chat.look.close")}
          title={t("chat.look.close")}
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <LookBody
          key={path}
          workspaceId={workspaceId}
          path={path}
          preview={support === "supported" && mode === "preview"}
        />
      </div>
    </div>
  );
}

/** Whether a file is shown as text: everything the binary viewers do not take. */
function isText(path: string): boolean {
  return !(
    isImageFile(path) ||
    mediaKindFor(path) ||
    isFontFile(path) ||
    isPdfFile(path) ||
    isSpreadsheetFile(path) ||
    isDocxFile(path) ||
    isPresentationFile(path)
  );
}

function LookBody({
  workspaceId,
  path,
  preview,
}: {
  workspaceId: string;
  path: string;
  preview: boolean;
}) {
  if (isImageFile(path)) {
    return (
      <div className="flex h-full">
        <ImagePreview workspaceId={workspaceId} filePath={path} />
      </div>
    );
  }
  const media = mediaKindFor(path);
  if (media) return <MediaEditorView filePath={path} workspaceId={workspaceId} kind={media} />;
  if (isFontFile(path)) return <FontEditorView filePath={path} workspaceId={workspaceId} />;
  if (isPdfFile(path)) return <PdfEditorView filePath={path} workspaceId={workspaceId} />;
  if (isSpreadsheetFile(path)) {
    return <SpreadsheetEditorView filePath={path} workspaceId={workspaceId} />;
  }
  if (isDocxFile(path)) return <DocxEditorView filePath={path} workspaceId={workspaceId} />;
  if (isPresentationFile(path)) return <PptxEditorView filePath={path} workspaceId={workspaceId} />;
  return <LookText workspaceId={workspaceId} path={path} preview={preview} />;
}

/**
 * A text file, previewed or as read-only source. One under the workspace
 * shares the editor's model; one outside it is read the way an outside
 * file opens in the editor.
 */
function LookText({
  workspaceId,
  path,
  preview,
}: {
  workspaceId: string;
  path: string;
  preview: boolean;
}) {
  const { t } = useTranslation();
  const location = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.location,
  );
  const root = location
    ? location.kind === "local"
      ? location.rootPath
      : location.remotePath
    : "";
  const rootPath = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? "",
  );
  const inside = isUnder(path, root);
  const { model, phase, errorCode } = useSharedModel({
    workspaceId,
    filePath: path,
    origin: inside ? "workspace" : "external",
  });
  const source = useModelSource(preview ? (model ?? null) : null);

  if (phase === "loading" || (phase === "ready" && !model)) {
    return <EmptyState title={t("editor.loading")} tone="status" className="h-full" />;
  }
  if (phase === "binary") {
    return <EmptyState title={t("editor.binary_file")} tone="status" className="h-full" />;
  }
  if (phase === "error") {
    return (
      <EmptyState
        title={fileErrorMessage(errorCode ?? "OTHER", MAX_READABLE_FILE_SIZE / (1024 * 1024))}
        tone="status"
        className="h-full"
      />
    );
  }
  if (preview) {
    return (
      <PreviewFindScope className="h-full">
        <PreviewPane
          filePath={path}
          workspaceId={workspaceId}
          workspaceRootAbsPath={rootPath}
          source={source}
        />
      </PreviewFindScope>
    );
  }
  return <LookSource model={model ?? null} />;
}

const sourceOptions = {
  readOnly: true,
  domReadOnly: true,
  minimap: { enabled: false },
  fontSize: typeScale.codeBody.fontSize,
  fontFamily: fontFamily.monoBody,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderLineHighlight: "none",
} satisfies Monaco.editor.IStandaloneEditorConstructionOptions;

/** The file's source in a read-only editor on the shared model. */
function LookSource({ model }: { model: Monaco.editor.ITextModel | null }) {
  const theme = useMonacoThemeName();
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const { attach, rememberAsTemporary } = useSharedModelAttach({
    editorRef,
    model,
    readOnly: true,
  });
  return (
    <Editor
      height="100%"
      keepCurrentModel
      saveViewState={false}
      theme={theme}
      options={sourceOptions}
      onMount={(editor) => {
        editorRef.current = editor;
        editor.onDidDispose(() => {
          if (editorRef.current === editor) editorRef.current = null;
        });
        rememberAsTemporary(editor);
        attach(editor);
      }}
    />
  );
}
