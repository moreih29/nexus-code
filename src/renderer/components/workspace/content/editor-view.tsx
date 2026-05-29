import Editor from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { useCallback, useEffect, useState } from "react";
import { fontFamily, typeScale } from "../../../../shared/design-tokens";
import { MAX_READABLE_FILE_SIZE } from "../../../../shared/fs/defaults";
import { useMonacoThemeName } from "../../../hooks/use-monaco-theme-name";
import { ipcCallResult } from "../../../ipc/client";
import { useSharedModel } from "../../../services/editor";
import { hasConflictMarkers } from "../../../services/editor/conflict/conflict-parser";
import { isPreviewable, previewEngineFor } from "../../../services/editor/preview/previewable";
import { toggleTaskMarker } from "../../../services/editor/preview/task-toggle";
import { useGitSession, useGitStore } from "../../../state/stores/git";
import { useTabsStore } from "../../../state/stores/tabs";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { cn } from "../../../utils/cn";
import { fileErrorMessage } from "../../../utils/file-error";
import { relPath } from "../../../utils/path";
import { HtmlPreview } from "../../editor/preview/html-preview";
import { ImagePreview } from "../../editor/preview/image-preview";
import { MarkdownPreview } from "../../editor/preview/markdown-preview";
import { SvgPreview } from "../../editor/preview/svg-preview";
import { ViewModeToggle } from "../../editor/preview/view-mode-toggle";
import { EmptyState } from "../../ui/empty-state";
import { ConflictResolvedBanner } from "./conflict-resolved-banner";
import { EditorBreadcrumbs } from "./editor-breadcrumbs";
import { ReadOnlyBanner } from "./read-only-banner";
import { useEditorMount } from "./use-editor-mount";

// Re-export for consumers (including drift-prone tests).
export { createCrossFileOpenCodeEditorOpener } from "../../../services/editor/tabs/cross-file-opener";

interface EditorViewProps {
  filePath: string;
  workspaceId: string;
  /**
   * Owning tab id, threaded through by ContentHost. Used to read/write the
   * per-tab `viewMode` (raw/preview) in the tabs store. Splits of the same
   * file can therefore hold one tab in raw mode and another in preview
   * mode independently.
   */
  tabId: string;
  /**
   * Model origin forwarded to the shared-model cache. Defaults to "workspace"
   * when omitted. Must be "untitled" for unsaved new-file buffers so the
   * cache routes to `createUntitledEntry` (no fs I/O, no LSP, immediate ready).
   */
  origin?: "workspace" | "external" | "untitled";
}

const editorOptions = {
  minimap: { enabled: false },
  fontSize: typeScale.codeBody.fontSize,
  fontFamily: fontFamily.monoBody,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  // Monaco's standalone editor disables LSP semantic tokens by default —
  // 'semanticHighlighting.enabled' defaults to 'configuredByTheme' which
  // requires a theme-level `semanticHighlighting` flag, but that property
  // does NOT exist on IStandaloneThemeData and is silently dropped by
  // monaco.editor.defineTheme(). Setting the editor option directly is the
  // canonical way to enable semantic-tokens rendering, per Monaco's
  // official sample (microsoft/monaco-editor PR #2103). Without this flag,
  // registerDocumentSemanticTokensProvider keeps being called but Monaco
  // discards the returned tokens entirely.
  "semanticHighlighting.enabled": true,
} satisfies Monaco.editor.IStandaloneEditorConstructionOptions;

/**
 * Returns whether the current file is listed as conflicted in the git merge
 * group for this workspace. Uses `repoInfo.topLevel` to compute the
 * git-relative path that matches `GitStatusEntry.relPath`.
 */
function useIsFileConflicted(filePath: string, workspaceId: string): boolean {
  const session = useGitSession(workspaceId);
  if (!session?.status) return false;

  const repoRoot =
    session.repoInfo.kind === "repo"
      ? session.repoInfo.topLevel
      : (useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId)?.rootPath ??
        null);

  if (!repoRoot) return false;

  const gitRelPath = relPath(filePath, repoRoot);
  return session.status.merge.some(
    (entry) => entry.relPath === gitRelPath && entry.conflictType !== null,
  );
}

/**
 * Tracks whether the Monaco model's current text contains conflict markers.
 * Subscribes to `onDidChangeContent` so the value updates in real time as the
 * user accepts conflict blocks.
 *
 * `model.isDisposed()` guards every `getValue()` call. The shared-model cache
 * disposes the underlying TextModel asynchronously (refcount drop, workspace
 * cleanup, external-model eviction) and the React state can still hold the
 * stale reference for one render — without the guard, the passive effect
 * mounts against a disposed model and Monaco throws "Model is disposed!",
 * which bubbles into the workspace ErrorBoundary and causes dev-mode error
 * recovery to remount the editor subtree in a loop.
 */
/**
 * Live-tracks the Monaco model's text as React state, coalesced to one
 * update per animation frame. Used by the Preview panes so raw edits flow
 * into the rendered output without re-reading `model.getValue()` on every
 * render. External-change reconciliation also fires `onDidChangeContent`
 * once the cache replaces the buffer, so this single subscription covers
 * both "user typed" and "file changed on disk" reflows.
 *
 * EAGER RESYNC ON MODEL IDENTITY CHANGE
 *   `useEffect` runs after commit, so the first render after a raw→preview
 *   toggle would otherwise show the stale `""` source until the effect
 *   fires. For `<iframe srcDoc>` consumers (HtmlPreview) that initial empty
 *   document can latch and the pane stays blank. We use the "adjust state
 *   during render" pattern (React docs §Derived State) to pull the new
 *   model's value synchronously whenever its identity changes.
 */
function useModelSource(model: Monaco.editor.ITextModel | null): string {
  const [trackedModel, setTrackedModel] = useState(model);
  const [source, setSource] = useState<string>(() =>
    model && !model.isDisposed() ? model.getValue() : "",
  );

  if (trackedModel !== model) {
    setTrackedModel(model);
    setSource(model && !model.isDisposed() ? model.getValue() : "");
  }

  useEffect(() => {
    if (!model || model.isDisposed()) return;

    let rafId: number | null = null;
    const flush = () => {
      rafId = null;
      if (!model.isDisposed()) setSource(model.getValue());
    };
    const sub = model.onDidChangeContent(() => {
      if (model.isDisposed()) return;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(flush);
    });
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      sub.dispose();
    };
  }, [model]);

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
      // The change event can fire one tick before the cache disposes the model
      // (reload-from-disk → cleanup paths). Re-check before touching it.
      if (model.isDisposed()) return;
      setHasMarkers(hasConflictMarkers(model.getValue()));
    });
    return () => disposable.dispose();
  }, [model]);

  return hasMarkers;
}

export function EditorView({ filePath, workspaceId, tabId, origin }: EditorViewProps) {
  const { model, phase, errorCode, readOnly } = useSharedModel({ workspaceId, filePath, origin });
  const monacoTheme = useMonacoThemeName();

  const { onMount } = useEditorMount({
    filePath,
    workspaceId,
    model: model ?? null,
    readOnly,
    phase,
  });

  // Conflict-resolved banner state — only computed when the file is writable.
  const isConflicted = useIsFileConflicted(filePath, workspaceId);
  const hasMarkers = useModelHasMarkers(!readOnly ? (model ?? null) : null);
  const markResolved = useGitStore((s) => s.markResolved);

  // ----- Raw/Preview view-mode wiring (plan 60) ----------------------------
  // previewSupport stays stable for a given filePath because EditorView keys
  // on filePath; computing it inline avoids a memo. View mode reads from the
  // tabs store so split tabs of the same file can hold independent modes.
  const previewSupport = isPreviewable(filePath);
  const storedViewMode = useTabsStore((s) =>
    s.byWorkspace[workspaceId]?.[tabId]?.type === "editor"
      ? s.byWorkspace[workspaceId]?.[tabId]
      : null,
  );
  const viewMode =
    storedViewMode && storedViewMode.type === "editor" ? (storedViewMode.viewMode ?? "raw") : "raw";
  const setViewMode = useTabsStore((s) => s.setViewMode);

  // Live markdown/html/svg source — subscribed only when actually previewing,
  // since react-markdown re-parses on every state update and we don't want to
  // pay that cost when the user keeps the toggle on Raw.
  const showPreview = viewMode === "preview" && previewSupport === "supported";
  const previewSource = useModelSource(showPreview ? (model ?? null) : null);

  // Toggle a GFM task checkbox from the markdown preview back into the model.
  // The edit goes through `pushEditOperations` so it lands on the undo stack
  // and marks the buffer dirty — identical to the user typing the change in
  // the editor. Suppressed when the model is read-only.
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

  // Workspace root for link/image resolution inside the markdown renderer.
  const workspaceRootAbsPath = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? "",
  );

  if (phase === "loading" || (phase === "ready" && !model)) {
    return <EmptyState title="Loading…" tone="status" className="min-h-0" />;
  }

  if (phase === "binary") {
    return <EmptyState title="Cannot display binary file." tone="status" className="min-h-0" />;
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
    void markResolved(workspaceId, [relPath(filePath, repoRoot)]);
  }

  return (
    <div className="flex flex-col h-full">
      {readOnly && (
        <ReadOnlyBanner
          filePath={filePath}
          onRevealInFinder={() => {
            // Fire-and-forget: reveal in OS is a one-shot shell action with no UI feedback.
            void ipcCallResult("system", "revealInOS", { absPath: filePath });
          }}
        />
      )}
      {!readOnly && (
        <ConflictResolvedBanner
          isConflicted={isConflicted}
          hasMarkers={hasMarkers}
          onMarkResolved={handleMarkResolved}
        />
      )}

      {/*
        Toolbar row — always shown for editor tabs. Left: workspace-relative
        breadcrumb so the user can locate the file at a glance. Right: the
        Raw/Preview toggle, present only when the file extension supports
        rendering (markdown/html/svg). For non-previewable files the row
        still appears so the breadcrumb keeps a consistent location across
        all editor tabs.
      */}
      <div className="flex items-center justify-between gap-2 px-2 py-1 border-b border-[var(--surface-island-border)]">
        <EditorBreadcrumbs filePath={filePath} workspaceRootAbsPath={workspaceRootAbsPath} />
        {previewSupport !== "none" && (
          <ViewModeToggle
            mode={viewMode}
            onChange={(mode) => setViewMode(workspaceId, tabId, mode)}
            disabled={previewSupport === "mdx-disabled"}
            disabledReason={
              previewSupport === "mdx-disabled" ? "MDX preview is disabled for security" : undefined
            }
          />
        )}
      </div>

      {/*
        Keep Monaco mounted at all times — toggling to Preview only hides it
        via CSS. Unmounting would tear down the model attachment and force a
        heavyweight re-create cycle when the user toggles back to Raw.
      */}
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
        <div className="flex-1 min-h-0">
          <PreviewPane
            filePath={filePath}
            workspaceId={workspaceId}
            workspaceRootAbsPath={workspaceRootAbsPath}
            source={previewSource}
            onToggleTask={readOnly ? undefined : onToggleTask}
          />
        </div>
      )}
    </div>
  );
}

interface ImageEditorViewProps {
  filePath: string;
  workspaceId: string;
}

/**
 * Editor surface for raster image files. Renders the same breadcrumb
 * toolbar row as the text editor so split tabs feel consistent, and hands
 * off the file body to ImagePreview (custom-protocol `<img>`).
 *
 * The toolbar's right slot — which holds the Raw/Preview toggle for text
 * tabs — is repurposed here as a resolution chip ("3840 × 2160"). Pixel
 * dimensions are reported up from ImagePreview's onLoad callback so the
 * image fetch isn't duplicated. Each split tab carries its own resolution
 * because ImageEditorView mounts per split.
 *
 * No model acquisition, no Monaco mount, no raw/preview toggle — images
 * are non-editable in v1.
 */
export function ImageEditorView({ filePath, workspaceId }: ImageEditorViewProps) {
  const workspaceRootAbsPath = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? "",
  );
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);

  // useCallback so ImagePreview's onLoad doesn't re-fire on every parent
  // render. The image's intrinsic size is stable for a given filePath
  // (the host keys EditorView on filePath, so a new file = new instance).
  const handleNaturalSize = useCallback((size: { w: number; h: number }) => {
    setNaturalSize(size);
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-2 px-2 py-1 border-b border-[var(--surface-island-border)]">
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

/**
 * Compact width × height label rendered on the right of the image
 * editor's toolbar row. Uses U+00D7 (×) for typographic correctness and
 * tabular-nums so digits don't shift as the value lands.
 */
function ImageResolutionChip({ size }: { size: { w: number; h: number } }) {
  const label = `${size.w} × ${size.h}`;
  return (
    <span
      className="text-app-ui-sm tabular-nums text-muted-foreground px-1 select-none"
      title={`Image resolution: ${label} pixels`}
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
  /** Forwarded to MarkdownPreview for interactive task checkboxes. */
  onToggleTask?: (modelLine: number) => void;
}

/**
 * Dispatches the concrete preview component based on the file's extension.
 * Pulled out so EditorView's render stays linear and the dispatch table is
 * easy to extend (e.g. adding `.json` schema preview later).
 */
function PreviewPane({
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
        <MarkdownPreview
          source={source}
          workspaceId={workspaceId}
          currentFileAbsPath={filePath}
          workspaceRootAbsPath={workspaceRootAbsPath}
          onToggleTask={onToggleTask}
        />
      );
    case "html":
      return <HtmlPreview source={source} />;
    case "svg":
      return <SvgPreview source={source} />;
  }
}
