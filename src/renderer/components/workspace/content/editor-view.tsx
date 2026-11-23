import Editor from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { fontFamily, typeScale } from "../../../../shared/design-tokens";
import { MAX_READABLE_FILE_SIZE } from "../../../../shared/fs/defaults";
import { useBannerDismissal } from "../../../hooks/use-banner-dismissal";
import { useMonacoThemeName } from "../../../hooks/use-monaco-theme-name";
import { ipcCallResult } from "../../../ipc/client";
import { useSharedModel } from "../../../services/editor";
import { hasConflictMarkers } from "../../../services/editor/conflict/conflict-parser";
import { delimiterFor } from "../../../services/editor/preview/delimited";
import { previewUpdateDelay } from "../../../services/editor/preview/pace";
import {
  defaultViewMode,
  isPreviewable,
  previewEngineFor,
} from "../../../services/editor/preview/previewable";
import { toggleTaskMarker } from "../../../services/editor/preview/task-toggle";
import { useGitSession, useGitStore } from "../../../state/stores/git";
import { usePreviewDefaultsStore } from "../../../state/stores/preview-defaults";
import { useTabsStore } from "../../../state/stores/tabs";
import { useWorkspace, useWorkspacesStore } from "../../../state/stores/workspaces";
import { cn } from "../../../utils/cn";
import { fileErrorMessage } from "../../../utils/file-error";
import { relativeTo } from "../../../utils/path";
import { HtmlPreview } from "../../editor/preview/html-preview";
import { ImagePreview } from "../../editor/preview/image-preview";
import { JsonTreePreview } from "../../editor/preview/json-tree-preview";
import { PreviewFindScope } from "../../editor/preview/preview-find";
import { SvgPreview } from "../../editor/preview/svg-preview";
import { TablePreview } from "../../editor/preview/table-preview";
import { ViewModeToggle } from "../../editor/preview/view-mode-toggle";
import { YamlTreePreview } from "../../editor/preview/yaml-tree-preview";
import { EmptyState } from "../../ui/empty-state";
import { ConflictResolvedBanner } from "./conflict-resolved-banner";
import { EditorBreadcrumbs } from "./editor-breadcrumbs";
import { ReadOnlyBanner } from "./read-only-banner";
import { useEditorMount } from "./use-editor-mount";

export { createCrossFileOpenCodeEditorOpener } from "../../../services/editor/tabs/cross-file-opener";

const MarkdownPreview = lazy(() =>
  import("../../editor/preview/markdown-preview").then(({ MarkdownPreview }) => ({
    default: MarkdownPreview,
  })),
);
const NotebookPreview = lazy(() =>
  import("../../editor/preview/notebook-preview").then(({ NotebookPreview }) => ({
    default: NotebookPreview,
  })),
);

interface EditorViewProps {
  filePath: string;
  workspaceId: string;
  tabId: string;
  origin?: "workspace" | "external" | "untitled";
}

const editorOptions = {
  minimap: { enabled: false },
  fontSize: typeScale.codeBody.fontSize,
  fontFamily: fontFamily.monoBody,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  "semanticHighlighting.enabled": true,
} satisfies Monaco.editor.IStandaloneEditorConstructionOptions;

function useIsFileConflicted(filePath: string, workspaceId: string): boolean {
  const session = useGitSession(workspaceId);
  if (!session?.status) return false;

  const repoRoot =
    session.repoInfo.kind === "repo"
      ? session.repoInfo.topLevel
      : (useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId)?.rootPath ??
        null);

  if (!repoRoot) return false;

  const gitRelPath = relativeTo(filePath, repoRoot);
  return session.status.merge.some(
    (entry) => entry.relPath === gitRelPath && entry.conflictType !== null,
  );
}

export function useModelSource(
  model: Monaco.editor.ITextModel | null,
  view?: React.RefObject<HTMLElement | null>,
): string {
  const [trackedModel, setTrackedModel] = useState(model);
  const [source, setSource] = useState<string>(() =>
    model && !model.isDisposed() ? model.getValue() : "",
  );

  if (trackedModel !== model) {
    setTrackedModel(model);
    setSource(model && !model.isDisposed() ? model.getValue() : "");
  }

  const updateCost = useRef(0);
  const updateAskedAt = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: measures each commit of a new text
  useLayoutEffect(() => {
    if (updateAskedAt.current === null) return;
    updateCost.current = performance.now() - updateAskedAt.current;
    updateAskedAt.current = null;
  }, [source]);

  useEffect(() => {
    if (!model || model.isDisposed()) return;
    const viewEl = view?.current ?? null;

    let rafId: number | null = null;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let parked = false;
    let behind = false;
    let lastUpdate = 0;
    const read = (): void => {
      const text = model.getValue();
      lastUpdate = performance.now();
      updateAskedAt.current = lastUpdate;
      setSource((shown) => {
        if (shown === text) updateAskedAt.current = null;
        return text;
      });
    };
    const flush = () => {
      rafId = null;
      timerId = null;
      if (model.isDisposed()) return;
      if (parked) {
        behind = true;
        return;
      }
      read();
    };
    const sub = model.onDidChangeContent(() => {
      if (model.isDisposed()) return;
      if (parked) {
        behind = true;
        return;
      }
      if (rafId !== null || timerId !== null) return;
      const wait = viewEl
        ? previewUpdateDelay(lastUpdate, updateCost.current, performance.now())
        : 0;
      if (wait > 0) timerId = setTimeout(flush, wait);
      else rafId = requestAnimationFrame(flush);
    });
    const resize = viewEl
      ? new ResizeObserver(([entry]) => {
          parked =
            viewEl.isConnected && entry.contentRect.width === 0 && entry.contentRect.height === 0;
          if (parked || !behind || model.isDisposed()) return;
          behind = false;
          flushSync(read);
        })
      : null;
    if (viewEl) resize?.observe(viewEl);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (timerId !== null) clearTimeout(timerId);
      resize?.disconnect();
      sub.dispose();
    };
  }, [model, view]);

  return source;
}

function useModelHasMarkers(model: Monaco.editor.ITextModel | null): boolean {
  const [hasMarkers, setHasMarkers] = useState<boolean>(() =>
    model && !model.isDisposed() ? hasConflictMarkers(model.getValue()) : false,
  );

  useEffect(() => {
    if (!model || model.isDisposed()) {
      setHasMarkers(false);
      return;
    }
    setHasMarkers(hasConflictMarkers(model.getValue()));
    const disposable = model.onDidChangeContent(() => {
      if (model.isDisposed()) return;
      setHasMarkers(hasConflictMarkers(model.getValue()));
    });
    return () => disposable.dispose();
  }, [model]);

  return hasMarkers;
}

export function EditorView({ filePath, workspaceId, tabId, origin }: EditorViewProps) {
  const { t } = useTranslation();
  const { model, phase, errorCode, readOnly } = useSharedModel({ workspaceId, filePath, origin });
  const monacoTheme = useMonacoThemeName();

  const { onMount } = useEditorMount({
    filePath,
    workspaceId,
    tabId,
    model: model ?? null,
    readOnly,
    phase,
  });

  const isConflicted = useIsFileConflicted(filePath, workspaceId);
  const hasMarkers = useModelHasMarkers(!readOnly && isConflicted ? (model ?? null) : null);
  const markResolved = useGitStore((s) => s.markResolved);
  const readOnlyNotice = useBannerDismissal(
    ["editor-read-only", workspaceId, tabId, filePath],
    readOnly ? [true] : undefined,
    phase === "ready",
  );
  const conflictNotice = useBannerDismissal(
    ["editor-conflict-resolved", workspaceId, tabId, filePath],
    !readOnly && isConflicted && !hasMarkers ? [true] : undefined,
    phase === "ready",
  );

  const previewSupport = isPreviewable(filePath);
  const storedViewMode = useTabsStore((s) =>
    s.byWorkspace[workspaceId]?.[tabId]?.type === "editor"
      ? s.byWorkspace[workspaceId]?.[tabId]
      : null,
  );
  const viewDefaults = usePreviewDefaultsStore((s) => s.byFormat);
  const viewMode =
    (storedViewMode?.type === "editor" ? storedViewMode.viewMode : undefined) ??
    defaultViewMode(filePath, viewDefaults);
  const setViewMode = useTabsStore((s) => s.setViewMode);

  const showPreview = viewMode === "preview" && previewSupport === "supported";
  const viewRef = useRef<HTMLDivElement | null>(null);
  const previewSource = useModelSource(showPreview ? (model ?? null) : null, viewRef);

  const onToggleTask = useCallback(
    (modelLine: number) => {
      if (!model || model.isDisposed() || readOnly) return;
      if (modelLine < 1 || modelLine > model.getLineCount()) return;
      const lineContent = model.getLineContent(modelLine);
      const toggled = toggleTaskMarker(lineContent);
      if (toggled === null) return;
      model.pushEditOperations(
        null,
        [
          {
            range: {
              startLineNumber: modelLine,
              startColumn: 1,
              endLineNumber: modelLine,
              endColumn: lineContent.length + 1,
            },
            text: toggled,
          },
        ],
        () => null,
      );
    },
    [model, readOnly],
  );

  const workspaceRootAbsPath = useWorkspace(workspaceId, (w) => w?.rootPath ?? "");

  if (phase === "loading" || (phase === "ready" && !model)) {
    return <EmptyState title={t("editor.loading")} tone="status" className="min-h-0" />;
  }

  if (phase === "binary") {
    return <EmptyState title={t("editor.binary_file")} tone="status" className="min-h-0" />;
  }

  if (phase === "error") {
    return (
      <EmptyState
        title={fileErrorMessage(errorCode ?? "OTHER", MAX_READABLE_FILE_SIZE / (1024 * 1024))}
        tone="status"
        className="min-h-0"
      />
    );
  }

  function handleMarkResolved(): void {
    const session = useGitStore.getState().sessions.get(workspaceId);
    if (!session) return;
    const repoRoot =
      session.repoInfo.kind === "repo"
        ? session.repoInfo.topLevel
        : (useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId)?.rootPath ??
          null);
    if (!repoRoot) return;
    void markResolved(workspaceId, [relativeTo(filePath, repoRoot)]);
  }

  return (
    <div ref={viewRef} className="flex flex-col h-full">
      {readOnly && !readOnlyNotice.dismissed && (
        <ReadOnlyBanner
          dismiss={readOnlyNotice.dismiss}
          onRevealInFinder={() => {
            void ipcCallResult("system", "revealInOS", { absPath: filePath });
          }}
        />
      )}
      {!readOnly && !conflictNotice.dismissed && (
        <ConflictResolvedBanner
          dismiss={conflictNotice.dismiss}
          isConflicted={isConflicted}
          hasMarkers={hasMarkers}
          onMarkResolved={handleMarkResolved}
        />
      )}

      <div className="flex items-center justify-between gap-2 overflow-hidden px-2 py-1 border-b border-[var(--surface-island-border)]">
        <EditorBreadcrumbs filePath={filePath} workspaceRootAbsPath={workspaceRootAbsPath} />
        {previewSupport !== "none" && (
          <ViewModeToggle
            mode={viewMode}
            onChange={(mode) => setViewMode(workspaceId, tabId, mode)}
            disabled={previewSupport === "mdx-disabled"}
            disabledReason={
              previewSupport === "mdx-disabled" ? t("editor.mdx_disabled") : undefined
            }
          />
        )}
      </div>

      <div className={cn("flex-1 min-h-0", showPreview && "hidden")}>
        <Editor
          height="100%"
          keepCurrentModel
          saveViewState={false}
          onMount={onMount}
          theme={monacoTheme}
          options={editorOptions}
        />
      </div>

      {showPreview && (
        <PreviewFindScope className="flex-1 min-h-0">
          <PreviewPane
            filePath={filePath}
            workspaceId={workspaceId}
            workspaceRootAbsPath={workspaceRootAbsPath}
            source={previewSource}
            onToggleTask={readOnly ? undefined : onToggleTask}
          />
        </PreviewFindScope>
      )}
    </div>
  );
}

interface ImageEditorViewProps {
  filePath: string;
  workspaceId: string;
}

export function ImageEditorView({ filePath, workspaceId }: ImageEditorViewProps) {
  const workspaceRootAbsPath = useWorkspace(workspaceId, (w) => w?.rootPath ?? "");
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);

  const handleNaturalSize = useCallback((size: { w: number; h: number }) => {
    setNaturalSize(size);
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-2 overflow-hidden px-2 py-1 border-b border-[var(--surface-island-border)]">
        <EditorBreadcrumbs filePath={filePath} workspaceRootAbsPath={workspaceRootAbsPath} />
        {naturalSize && <ImageResolutionChip size={naturalSize} />}
      </div>
      <div className="flex-1 min-h-0 flex">
        <ImagePreview
          workspaceId={workspaceId}
          filePath={filePath}
          onNaturalSize={handleNaturalSize}
        />
      </div>
    </div>
  );
}

function ImageResolutionChip({ size }: { size: { w: number; h: number } }) {
  const { t } = useTranslation();
  const label = `${size.w} × ${size.h}`;
  return (
    <span
      className="shrink-0 whitespace-nowrap text-app-ui-sm tabular-nums text-muted-foreground px-1 select-none"
      title={t("imagePreview.resolution", { size: label })}
    >
      {label}
    </span>
  );
}

interface PreviewPaneProps {
  filePath: string;
  workspaceId: string;
  workspaceRootAbsPath: string;
  source: string;
  onToggleTask?: (modelLine: number) => void;
}

export function PreviewPane({
  filePath,
  workspaceId,
  workspaceRootAbsPath,
  source,
  onToggleTask,
}: PreviewPaneProps) {
  const engine = previewEngineFor(filePath);
  switch (engine) {
    case "markdown":
      return (
        <Suspense fallback={null}>
          <MarkdownPreview
            source={source}
            workspaceId={workspaceId}
            currentFileAbsPath={filePath}
            workspaceRootAbsPath={workspaceRootAbsPath}
            onToggleTask={onToggleTask}
          />
        </Suspense>
      );
    case "html":
      return (
        <HtmlPreview
          source={source}
          workspaceId={workspaceId}
          currentFileAbsPath={filePath}
          workspaceRootAbsPath={workspaceRootAbsPath}
        />
      );
    case "svg":
      return <SvgPreview source={source} />;
    case "table":
      return <TablePreview source={source} delimiter={delimiterFor(filePath)} />;
    case "json":
      return <JsonTreePreview source={source} />;
    case "yaml":
      return <YamlTreePreview source={source} />;
    case "notebook":
      return (
        <Suspense fallback={null}>
          <NotebookPreview
            source={source}
            workspaceId={workspaceId}
            currentFileAbsPath={filePath}
            workspaceRootAbsPath={workspaceRootAbsPath}
          />
        </Suspense>
      );
  }
}
