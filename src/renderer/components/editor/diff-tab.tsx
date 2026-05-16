import type * as Monaco from "monaco-editor";
import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from "react";
import { fontFamily, typeScale } from "../../../shared/design-tokens";
import type { DiffTabPayload } from "../../../shared/types/tab";
import { NEXUS_DARK_THEME_NAME } from "../../services/editor/runtime/monaco-theme";
import {
  type DiffContentStatus,
  type DiffSideReadyState,
  type DiffSideState,
  readyContentFor,
  REFRESHING_INDICATOR_DELAY_MS,
  useDiffContent,
} from "./diff-content-loader";

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
  const leftContent = readyContentFor(left);
  const rightContent = readyContentFor(right);
  const blockingMessage = blockingPlaceholder(left, right, leftContent, rightContent);

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

  if (blockingMessage) {
    return (
      <DiffShell left={left} right={right} showRefreshing={showRefreshing} onReload={reload}>
        <Centered>{blockingMessage}</Centered>
      </DiffShell>
    );
  }

  if (!leftContent || !rightContent) {
    return (
      <DiffShell left={left} right={right} showRefreshing={showRefreshing} onReload={reload}>
        <Centered>Loading diff...</Centered>
      </DiffShell>
    );
  }

  return (
    <DiffShell left={left} right={right} showRefreshing={showRefreshing} onReload={reload}>
      <MissingContentNotice side="left" content={leftContent} />
      <MissingContentNotice side="right" content={rightContent} />
      <div className="min-h-0 flex-1">
        <Suspense fallback={<Centered>Loading Monaco diff editor...</Centered>}>
          <LazyDiffEditor
            height="100%"
            original={leftContent.content}
            modified={rightContent.content}
            originalModelPath={modelPathFor(leftContent)}
            modifiedModelPath={modelPathFor(rightContent)}
            theme={NEXUS_DARK_THEME_NAME}
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
          <button
            type="button"
            className="rounded-[4px] px-2 py-1 text-app-ui-sm hover:bg-frosted-veil-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50"
            onClick={onReload}
          >
            Reload
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

/**
 * Renders the side identity in the diff header.
 */
function SideLabel({ label, state }: { label: string; state: DiffSideState }) {
  return (
    <div className="min-w-0 truncate">
      <span className="text-muted-foreground">{label}</span>{" "}
      <span className="text-foreground">{state.request.ref}</span>{" "}
      <span className="text-muted-foreground">·</span>{" "}
      <span className="text-muted-foreground" title={state.request.relPath}>
        {state.request.relPath}
      </span>
    </div>
  );
}

/**
 * Centered empty/loading/error message used instead of mounting Monaco.
 */
function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-app-ui-sm text-muted-foreground">
      {children}
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
    <div className="shrink-0 border-b border-border bg-frosted-veil px-3 py-1 text-app-ui-sm text-muted-foreground">
      {label}; showing it as an empty file.
    </div>
  );
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
): ReactNode | null {
  const errorState = left.phase === "error" ? left : right.phase === "error" ? right : null;
  if (errorState) return errorState.message;

  const binarySides = [leftContent, rightContent].filter(
    (side): side is DiffSideReadyState => !!side?.isBinary,
  );
  if (binarySides.length === 0) return null;

  return (
    <div className="space-y-2">
      <div>Cannot display binary file in diff.</div>
      {binarySides.map((side) => (
        <div key={`${side.request.side}:${side.request.relPath}`} className="text-muted-foreground">
          {side.request.side === "left" ? "Left" : "Right"}: {side.request.relPath} (
          {formatBytes(side.sizeBytes)})
        </div>
      ))}
    </div>
  );
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
