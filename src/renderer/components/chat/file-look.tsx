import Editor from "@monaco-editor/react";
import { GitCompareArrows } from "lucide-react";
import type * as Monaco from "monaco-editor";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MAX_READ_BYTES } from "../../../../packages/remote-protocol/src/rpc";
import { fontFamily, typeScale } from "../../../shared/design-tokens";
import { MAX_READABLE_FILE_SIZE } from "../../../shared/fs/defaults";
import { toSlashPath } from "../../../shared/fs/drive-path";
import { FS_ERROR } from "../../../shared/fs/errors";
import { useMonacoThemeName } from "../../hooks/use-monaco-theme-name";
import { useChatFiles } from "../../services/chat/chat-files";
import type { Size } from "../../services/chat/image-look";
import { isUnder, type LineAt } from "../../services/chat/links";
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
import {
  usePeerWorkspaceRevision,
  usePeerWorkspaceText,
} from "../../services/remote/peer-file-live";
import { type PeerText, peerOf, usePeerText } from "../../services/remote/peer-workspace";
import { usePreviewDefaultsStore } from "../../state/stores/preview-defaults";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { cn } from "../../utils/cn";
import { fileErrorMessage } from "../../utils/file-error";
import { ImagePreview } from "../editor/preview/image-preview";
import { PreviewFindScope } from "../editor/preview/preview-find";
import { PeerPreviewVersion } from "../editor/preview/use-file-version";
import { ViewModeToggle } from "../editor/preview/view-mode-toggle";
import { EmptyState } from "../ui/empty-state";
import { IconButton } from "../ui/icon-button";
import { DocxEditorView } from "../workspace/content/docx-editor-view";
import { useSharedModelAttach } from "../workspace/content/editor-mount/use-shared-model-attach";
import { PreviewPane, useModelSource } from "../workspace/content/editor-view";
import { FontEditorView } from "../workspace/content/font-editor-view";
import { MediaEditorView } from "../workspace/content/media-editor-view";
import { PdfEditorView } from "../workspace/content/pdf-editor-view";
import { PptxEditorView } from "../workspace/content/pptx-editor-view";
import { SpreadsheetEditorView } from "../workspace/content/spreadsheet-editor-view";
import { LookDiff, PeerLookDiff } from "./look-diff";

export interface FileLookOptions {
  at?: LineAt;
  before?: string | null;
  mode?: ViewMode;
  compare?: boolean;
}

/** Tracks the selected view and the controls both file surfaces offer. */
export function useFileLookView(path: string, options: FileLookOptions) {
  const defaults = usePreviewDefaultsStore((s) => s.byFormat);
  const { at, before } = options;
  const changed = before !== undefined;
  const firstMode = options.mode ?? (at?.line ? "raw" : defaultViewMode(path, defaults));
  const firstDiff = changed && (options.compare ?? !at?.line);
  const [mode, setMode] = useState<ViewMode>(firstMode);
  const [diff, setDiff] = useState(firstDiff);
  const selection = JSON.stringify([
    path,
    at?.line,
    at?.column,
    options.mode,
    options.compare,
    changed,
  ]);
  const [viewFor, setViewFor] = useState(selection);
  if (viewFor !== selection) {
    setViewFor(selection);
    setMode(firstMode);
    setDiff(firstDiff);
  }
  return { changed, mode, showDiff: diff && changed, setMode, setDiff };
}

export function FileLookControls({
  path,
  view,
  onModeChange = view.setMode,
  onCompareChange = view.setDiff,
}: {
  path: string;
  view: ReturnType<typeof useFileLookView>;
  onModeChange?: (mode: ViewMode) => void;
  onCompareChange?: (compare: boolean) => void;
}) {
  const { t } = useTranslation();
  const support = isPreviewable(path);
  return (
    <>
      {view.changed && (
        <IconButton
          label={t("chat.look.changes")}
          className={cn(view.showDiff && "bg-[var(--state-active-bg)] text-foreground")}
          onClick={() => onCompareChange(!view.showDiff)}
          aria-pressed={view.showDiff}
          data-testid="chat-quick-look-diff"
        >
          <GitCompareArrows className="size-3.5" />
        </IconButton>
      )}
      {!view.showDiff && isText(path) && support !== "none" && (
        <ViewModeToggle
          mode={view.mode}
          onChange={onModeChange}
          disabled={support === "mdx-disabled"}
          disabledReason={support === "mdx-disabled" ? t("editor.mdx_disabled") : undefined}
        />
      )}
    </>
  );
}

interface PeerFileLookOptions {
  watch: boolean;
  connection: number;
  toolbar: ReactNode;
}

/** A file's read-only body, shared by quick look and peer file tabs. */
export function FileLookBody({
  workspaceId,
  path,
  root,
  at,
  before,
  view,
  onImageSize,
  peerFile,
}: {
  workspaceId: string;
  path: string;
  root: string;
  at?: LineAt;
  before?: string | null;
  view: ReturnType<typeof useFileLookView>;
  onImageSize?: (size: Size) => void;
  peerFile?: PeerFileLookOptions;
}) {
  const { t } = useTranslation();
  const peer = peerOf(workspaceId) !== null;
  const chatFiles = useChatFiles();
  if (peer && !peerFile && chatFiles?.epoch === null) {
    return (
      <EmptyState
        title={
          isImageFile(path) && !view.showDiff
            ? t("imagePreview.load_failed")
            : fileErrorMessage("OTHER")
        }
        tone="status"
        className="h-full"
      />
    );
  }
  // Foreground changes recheck image bytes. A new connection also reloads documents.
  const key = peer ? JSON.stringify([workspaceId, path, chatFiles?.connection]) : path;
  if (view.showDiff) {
    return peer ? (
      <PeerLookDiff key={key} workspaceId={workspaceId} path={path} before={before ?? null} />
    ) : (
      <LookDiff key={key} workspaceId={workspaceId} path={path} before={before ?? null} />
    );
  }
  if (peer && peerFile) {
    return (
      <PeerWorkspaceLook
        key={JSON.stringify([workspaceId, path])}
        workspaceId={workspaceId}
        path={path}
        root={root}
        preview={isPreviewable(path) === "supported" && view.mode === "preview"}
        at={at}
        peerFile={peerFile}
      />
    );
  }
  return (
    <LookBody
      key={key}
      workspaceId={workspaceId}
      path={path}
      root={root}
      preview={isPreviewable(path) === "supported" && view.mode === "preview"}
      at={at}
      onImageSize={onImageSize}
      imageRevision={peer ? (chatFiles?.epoch ?? undefined) : undefined}
    />
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

function PeerWorkspaceLook({
  workspaceId,
  path,
  root,
  preview,
  at,
  peerFile,
}: {
  workspaceId: string;
  path: string;
  root: string;
  preview: boolean;
  at?: LineAt;
  peerFile: PeerFileLookOptions;
}) {
  const { watch, connection, toolbar } = peerFile;
  const text = isText(path);
  const revision = usePeerWorkspaceRevision(workspaceId, path, watch && !text, connection);

  if (!text) {
    const image = isImageFile(path);
    return (
      <div className="flex h-full min-h-0 flex-col">
        {image && <div className={FILE_LOOK_TOOLBAR_CLASS}>{toolbar}</div>}
        <div className="min-h-0 flex-1">
          <PeerPreviewVersion.Provider value={revision}>
            <LookBody
              workspaceId={workspaceId}
              path={path}
              root={root}
              preview={false}
              toolbar={toolbar}
            />
          </PeerPreviewVersion.Provider>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={FILE_LOOK_TOOLBAR_CLASS}>{toolbar}</div>
      <div className="min-h-0 flex-1">
        <PeerWorkspaceLookText
          workspaceId={workspaceId}
          path={path}
          root={root}
          preview={preview}
          at={at}
          watch={watch}
          connection={connection}
        />
      </div>
    </div>
  );
}

const FILE_LOOK_TOOLBAR_CLASS =
  "flex shrink-0 items-center justify-between gap-2 border-b border-[var(--surface-island-border)] px-2 py-1";

function LookBody({
  workspaceId,
  path,
  preview,
  at,
  onImageSize,
  toolbar,
  imageRevision,
  root,
}: {
  workspaceId: string;
  imageRevision?: number;
  toolbar?: ReactNode;
  path: string;
  preview: boolean;
  root: string;
  at?: LineAt;
  /** Hears an image file's size once it loads, which its box wraps. */
  onImageSize?: (size: Size) => void;
}) {
  if (isImageFile(path)) {
    return (
      <div className="flex h-full">
        <ImagePreview
          workspaceId={workspaceId}
          filePath={path}
          onNaturalSize={onImageSize}
          revision={imageRevision}
          fill
        />
      </div>
    );
  }
  const media = mediaKindFor(path);
  if (media)
    return (
      <MediaEditorView
        breadcrumbs={toolbar}
        filePath={path}
        workspaceId={workspaceId}
        kind={media}
      />
    );
  if (isFontFile(path))
    return <FontEditorView breadcrumbs={toolbar} filePath={path} workspaceId={workspaceId} />;
  if (isPdfFile(path))
    return <PdfEditorView breadcrumbs={toolbar} filePath={path} workspaceId={workspaceId} />;
  if (isSpreadsheetFile(path)) {
    return (
      <SpreadsheetEditorView breadcrumbs={toolbar} filePath={path} workspaceId={workspaceId} />
    );
  }
  if (isDocxFile(path))
    return <DocxEditorView breadcrumbs={toolbar} filePath={path} workspaceId={workspaceId} />;
  if (isPresentationFile(path))
    return <PptxEditorView breadcrumbs={toolbar} filePath={path} workspaceId={workspaceId} />;
  if (peerOf(workspaceId)) {
    return (
      <PeerLookText workspaceId={workspaceId} path={path} preview={preview} root={root} at={at} />
    );
  }
  return <LookText workspaceId={workspaceId} path={path} preview={preview} line={at?.line} />;
}

/**
 * A text file of another computer's, previewed or as read-only source, as
 * LookText shows one here.
 */
function PeerLookText({
  workspaceId,
  path,
  preview,
  root,
  at,
}: {
  workspaceId: string;
  path: string;
  preview: boolean;
  root: string;
  at?: LineAt;
}) {
  const read = usePeerText(workspaceId, path);
  return <PeerTextBody {...{ workspaceId, path, preview, root, at, read }} />;
}

function PeerWorkspaceLookText({
  watch,
  connection,
  ...file
}: Pick<PeerFileLookOptions, "watch" | "connection"> & Parameters<typeof PeerLookText>[0]) {
  const read = usePeerWorkspaceText(file.workspaceId, file.path, watch, connection);
  return <PeerTextBody {...file} read={read} />;
}

function PeerTextBody({
  workspaceId,
  path,
  preview,
  root,
  at,
  read,
}: Parameters<typeof PeerLookText>[0] & { read: PeerText | null }) {
  const { t } = useTranslation();
  if (read === null)
    return <EmptyState title={t("editor.loading")} tone="status" className="h-full" />;
  if (read.kind === "binary") {
    return <EmptyState title={t("editor.binary_file")} tone="status" className="h-full" />;
  }
  if (read.kind !== "text") {
    const message =
      read.kind === "failed" && read.reason === "not-found"
        ? t("peerWorkspace.missingFile")
        : read.kind === "failed" && read.reason === "unsupported"
          ? t("peerWorkspace.updateNeeded")
          : read.kind === "failed" && read.reason === "unavailable"
            ? t("peerWorkspace.connectionUnavailable")
            : fileErrorMessage(
                read.kind === "too_large" ? FS_ERROR.TOO_LARGE : "OTHER",
                MAX_READABLE_FILE_SIZE / (1024 * 1024),
              );
    return <EmptyState title={message} tone="status" className="h-full" />;
  }
  if (read.truncated) {
    let outsidePreview = false;
    if (at?.line !== undefined) {
      const lines = read.text.split(/\r\n?|\n/);
      outsidePreview = at.line > lines.length || (at.line === lines.length && lines.at(-1) === "");
    }
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div
          role="status"
          className="shrink-0 border-b border-border px-2 py-1 text-app-ui-sm text-[var(--state-warning-fg)]"
        >
          {outsidePreview
            ? t("peerWorkspace.textPrefixOutsideLine")
            : t("peerWorkspace.textPrefix", { size: MAX_READ_BYTES / 1024 })}
        </div>
        <div className="min-h-0 flex-1">
          <PeerSource path={path} text={read.text} at={outsidePreview ? undefined : at} />
        </div>
      </div>
    );
  }
  if (preview) {
    return (
      <PreviewFindScope className="h-full">
        <PreviewPane
          filePath={toSlashPath(path)}
          workspaceId={workspaceId}
          workspaceRootAbsPath={toSlashPath(root)}
          source={read.text}
        />
      </PreviewFindScope>
    );
  }
  return <PeerSource path={path} text={read.text} at={at} />;
}

/** Another computer's file's source in a read-only editor of its own model, a line marked when given. */
function PeerSource({ path, text, at }: { path: string; text: string; at?: LineAt }) {
  const theme = useMonacoThemeName();
  const [id] = useState(() => ++nextPeerSource);
  const [editor, setEditor] = useState<Monaco.editor.IStandaloneCodeEditor | null>(null);
  useEffect(() => {
    const { line, column } = at ?? {};
    const shown = editor?.getModel();
    if (editor && line && shown && line <= shown.getLineCount()) {
      editor.setSelection({
        startLineNumber: line,
        startColumn: column ?? 1,
        endLineNumber: line,
        endColumn: column ?? shown.getLineMaxColumn(line),
      });
      editor.revealLineInCenter(line);
    }
  }, [editor, at]);
  return (
    <Editor
      height="100%"
      path={`nexus-peer-look:///${id}/${toSlashPath(path).split("/").map(encodeURIComponent).join("/")}`}
      saveViewState={false}
      value={text}
      theme={theme}
      options={sourceOptions}
      onMount={setEditor}
    />
  );
}

/** Numbers the sources of other computers' files, so each one's model gets its own URI. */
let nextPeerSource = 0;

/**
 * A text file, previewed or as read-only source. One under the workspace
 * shares the editor's model; one outside it is read the way an outside
 * file opens in the editor.
 */
function LookText({
  workspaceId,
  path,
  preview,
  line,
}: {
  workspaceId: string;
  path: string;
  preview: boolean;
  line?: number;
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
  return <LookSource model={model ?? null} line={line} />;
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

/** The file's source in a read-only editor on the shared model, a line marked when given. */
function LookSource({ model, line }: { model: Monaco.editor.ITextModel | null; line?: number }) {
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
        const shown = editor.getModel();
        if (line && shown && line <= shown.getLineCount()) {
          // Selected, as the editor draws no line highlight here.
          editor.setSelection({
            startLineNumber: line,
            startColumn: 1,
            endLineNumber: line,
            endColumn: shown.getLineMaxColumn(line),
          });
          editor.revealLineInCenter(line);
        }
      }}
    />
  );
}
