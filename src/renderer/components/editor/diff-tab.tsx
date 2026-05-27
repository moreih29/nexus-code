import { useMonaco } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from "react";
import { fontFamily, typeScale } from "../../../shared/design-tokens";
import type { DiffTabPayload } from "../../../shared/types/tab";
import { useMonacoThemeName } from "../../hooks/use-monaco-theme-name";
import {
  type DiffContentStatus,
  type DiffSideReadyState,
  type DiffSideState,
  readyContentFor,
  REFRESHING_INDICATOR_DELAY_MS,
  useDiffContent,
} from "./diff-content-loader";
import { languageIdForPath } from "./language-id-for-path";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";

const LazyDiffEditor = lazy(async () => {
  const module = await import("@monaco-editor/react");
  return { default: module.DiffEditor };
});

const diffEditorOptions = {
  readOnly: true,
  originalEditable: false,
  renderSideBySide: true,
  // Monaco collapses the side-by-side diff into a single inline column once the
  // editor is narrower than `renderSideBySideInlineBreakpoint` (900px by
  // default). The Source Control diff often opens in a panel below that width,
  // which made the "Left → Right" header lie about a one-column body. Pin the
  // two-column layout regardless of available width.
  useInlineViewWhenSpaceIsLimited: false,
  minimap: { enabled: false },
  fontSize: typeScale.codeBody.fontSize,
  fontFamily: fontFamily.monoBody,
  scrollBeyondLastLine: false,
  automaticLayout: true,
} satisfies Monaco.editor.IDiffEditorConstructionOptions;

// IDiffEditorConstructionOptions doesn't include semanticHighlighting.enabled
// in its type but the runtime accepts it (the underlying single editors
// honour IGlobalEditorOptions). Cast handles the type gap.
(diffEditorOptions as Record<string, unknown>)["semanticHighlighting.enabled"] = true;

/**
 * Returns true only after `status` has been "refreshing" for longer than
 * REFRESHING_INDICATOR_DELAY_MS.  This prevents a visible flicker for fast
 * background reloads (e.g. every git.statusChanged) that complete well within
 * the threshold.  The timer is cancelled and the indicator hidden immediately
 * when the status leaves "refreshing".
 */
function useDelayedRefreshing(status: DiffContentStatus): boolean {
  const [showRefreshing, setShowRefreshing] = useState(false);

  useEffect(() => {
    if (status !== "refreshing") {
      setShowRefreshing(false);
      return;
    }
    const timer = setTimeout(() => setShowRefreshing(true), REFRESHING_INDICATOR_DELAY_MS);
    return () => clearTimeout(timer);
  }, [status]);

  return showRefreshing;
}

/**
 * Monaco-backed tab body for Source Control file diffs.
 */
export function DiffTab(payload: DiffTabPayload) {
  const { left, right, status, reload } = useDiffContent(payload);
  const showRefreshing = useDelayedRefreshing(status);
  const monacoTheme = useMonacoThemeName();
  // @monaco-editor/react가 monaco를 lazy 로딩하는 동안에는 null. DiffEditor
  // 자체도 monaco가 도착해야 mount되므로 그동안 우리도 prop을 "plaintext"로
  // 두면 되고, 도착 후 재렌더에서 올바른 languageId가 흘러간다.
  const monaco = useMonaco();
  const leftContent = readyContentFor(left);
  const rightContent = readyContentFor(right);
  const blocking = blockingPlaceholder(left, right, leftContent, rightContent);

  // Workaround for suren-atoyan/monaco-react#647 — mirrors microsoft/vscode#222197 fix order.
  // On unmount, reset the DiffEditorWidget model to null before the wrapper disposes the
  // TextModels; without this the widget still holds a reference and triggers
  // "TextModel got disposed before DiffEditorWidget model got reset".
  const editorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);

  useEffect(() => {
    return () => {
      editorRef.current?.setModel(null);
      editorRef.current = null;
    };
  }, []);

  if (blocking) {
    return (
      <DiffShell left={left} right={right} showRefreshing={showRefreshing} onReload={reload}>
        <EmptyState title={blocking.title} description={blocking.description} tone="status" className="min-h-0" />
      </DiffShell>
    );
  }

  if (!leftContent || !rightContent) {
    return (
      <DiffShell left={left} right={right} showRefreshing={showRefreshing} onReload={reload}>
        <EmptyState title="Loading diff…" tone="status" className="min-h-0" />
      </DiffShell>
    );
  }

  // @monaco-editor/react의 DiffEditor는 prop이 비면 language를 'text'로
  // 하드코딩해 Monaco의 URI 기반 자동 감지를 막는다 (suren-atoyan/monaco-react
  // `src/utils/index.ts` 의 `getOrCreateModel`). 그래서 path → languageId를
  // 직접 풀어 넘긴다. monaco 로딩 전이거나 매칭 실패면 Monaco 자체 기본값과
  // 같은 "plaintext"로 폴백.
  const originalLanguage =
    (monaco ? languageIdForPath(monaco, leftContent.request.relPath) : undefined) ?? "plaintext";
  const modifiedLanguage =
    (monaco ? languageIdForPath(monaco, rightContent.request.relPath) : undefined) ?? "plaintext";

  return (
    <DiffShell left={left} right={right} showRefreshing={showRefreshing} onReload={reload}>
      <MissingContentNotice side="left" content={leftContent} />
      <MissingContentNotice side="right" content={rightContent} />
      <div className="min-h-0 flex-1">
        <Suspense fallback={<EmptyState title="Loading Monaco diff editor…" tone="status" className="min-h-0" />}>
          <LazyDiffEditor
            height="100%"
            original={leftContent.content}
            modified={rightContent.content}
            originalLanguage={originalLanguage}
            modifiedLanguage={modifiedLanguage}
            originalModelPath={modelPathFor(leftContent)}
            modifiedModelPath={modelPathFor(rightContent)}
            theme={monacoTheme}
            options={diffEditorOptions}
            onMount={(editor) => {
              editorRef.current = editor;
            }}
          />
        </Suspense>
      </div>
    </DiffShell>
  );
}

interface DiffShellProps {
  left: DiffSideState;
  right: DiffSideState;
  /** True only after the refreshing state has persisted past the indicator delay threshold. */
  showRefreshing: boolean;
  onReload: () => void;
  children: ReactNode;
}

/**
 * Provides the common header and body frame for the diff editor states.
 */
function DiffShell({ left, right, showRefreshing, onReload, children }: DiffShellProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-border bg-muted px-3 text-app-ui-sm">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <SideLabel label="Left" state={left} />
          <span className="text-muted-foreground">→</span>
          <SideLabel label="Right" state={right} />
        </div>
        <div className="flex shrink-0 items-center gap-2 text-muted-foreground">
          {showRefreshing && <span>Refreshing…</span>}
          <Button type="button" variant="ghost" size="sm" onClick={onReload}>
            Reload
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

/**
 * Renders the side identity in the diff header.
 * The filename is the primary identifier; the ref hash is secondary context.
 */
function SideLabel({ label, state }: { label: string; state: DiffSideState }) {
  return (
    <div className="min-w-0 truncate">
      <span className="text-muted-foreground">{label}</span>{" "}
      <span className="text-foreground" title={state.request.relPath}>
        {state.request.relPath}
      </span>{" "}
      <span className="text-muted-foreground text-[0.75em]">({state.request.ref})</span>
    </div>
  );
}

/**
 * Shows when a git/fs side is absent and the diff uses empty content.
 */
function MissingContentNotice({
  side,
  content,
}: {
  side: "left" | "right";
  content: DiffSideReadyState;
}) {
  if (content.placeholder !== "missing") return null;
  const label = side === "left" ? "Left side is missing" : "Right side is missing";
  return (
    <div className="shrink-0 border-b border-border bg-muted px-3 py-1 text-app-ui-sm text-muted-foreground">
      {label}; showing it as an empty file.
    </div>
  );
}

interface BlockingPlaceholder {
  title: string;
  description?: string;
}

/**
 * Returns a message that should block Monaco from mounting, if any side cannot
 * be represented as plain text.
 */
function blockingPlaceholder(
  left: DiffSideState,
  right: DiffSideState,
  leftContent: DiffSideReadyState | undefined,
  rightContent: DiffSideReadyState | undefined,
): BlockingPlaceholder | null {
  const errorState = left.phase === "error" ? left : right.phase === "error" ? right : null;
  if (errorState) return { title: errorState.message };

  const binarySides = [leftContent, rightContent].filter(
    (side): side is DiffSideReadyState => !!side?.isBinary,
  );
  if (binarySides.length === 0) return null;

  const description = binarySides
    .map(
      (side) =>
        `${side.request.side === "left" ? "Left" : "Right"}: ${side.request.relPath} (${formatBytes(side.sizeBytes)})`,
    )
    .join("\n");

  return { title: "Cannot display binary file in diff.", description };
}

/**
 * Builds a stable Monaco model URI that preserves the file extension for syntax detection.
 */
function modelPathFor(content: DiffSideReadyState): string {
  const encodedPath = content.request.relPath.split("/").map(encodeURIComponent).join("/");
  return `nexus-diff:///${encodeURIComponent(content.request.workspaceId)}/${content.request.side}/${encodeURIComponent(content.request.ref)}/${encodedPath}`;
}

/**
 * Formats byte counts for binary-side placeholders.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib >= 10 ? 0 : 1)} KB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
}
