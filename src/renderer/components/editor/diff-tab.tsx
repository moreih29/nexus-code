import { useMonaco } from "@monaco-editor/react";
import i18next from "i18next";
import type * as Monaco from "monaco-editor";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fontFamily, typeScale } from "../../../shared/design-tokens";
import type { DiffTabPayload } from "../../../shared/types/tab";
import { useMonacoThemeName } from "../../hooks/use-monaco-theme-name";
import {
  type DiffStaging,
  installDiffStaging,
} from "../../services/editor/git/staging/diff-editor-staging";
import { acquireModel, releaseModel, useSharedModel } from "../../services/editor/model";
import { useDiffWorkingFile } from "../../services/editor/tabs";
import type { EditorInput } from "../../services/editor/types";
import { registerTabFocusTarget } from "../../services/tab-focus";
import {
  type DiffContentStatus,
  type DiffSideReadyState,
  type DiffSideState,
  readyContentFor,
  REFRESHING_INDICATOR_DELAY_MS,
  useDiffContent,
} from "./diff-content-loader";
import { EMPTY_TREE } from "./diff-refs";
import { languageIdForPath } from "./language-id-for-path";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";

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

/** Numbers diff editors so each one's snapshot models get their own URIs. */
let nextDiffEditorId = 0;

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

type DiffTabProps = DiffTabPayload & { tabId: string };

/**
 * Monaco-backed tab body for Source Control file diffs.
 *
 * A diff against the working tree edits the file itself, as VSCode's does:
 * its right side is the file's shared model, so changes made there (typed,
 * or reverted block by block from the gutter) are the file's own — dirty in
 * its editor tabs and saved with ⌘S. A diff whose right side is a git
 * revision (the index of a staged change) stays read-only.
 *
 * Changes stage from the diff of unstaged changes and unstage from the diff
 * of staged ones, one at a time from the gutter or by selected lines.
 */
export function DiffTab({ tabId, ...payload }: DiffTabProps) {
  const workingFile = useDiffWorkingFile(payload);
  // Keyed by file: a preview tab swapped onto another file mounts afresh,
  // rather than rendering the old file's model under the new file's path.
  return workingFile ? (
    <WorkingTreeDiff key={workingFile} tabId={tabId} payload={payload} filePath={workingFile} />
  ) : (
    <DiffView tabId={tabId} payload={payload} working={null} workingPending={false} />
  );
}

/** The working-tree file's model the right side edits. */
interface WorkingSide {
  model: Monaco.editor.ITextModel;
  input: EditorInput;
}

function WorkingTreeDiff({
  tabId,
  payload,
  filePath,
}: {
  tabId: string;
  payload: DiffTabPayload;
  filePath: string;
}) {
  const { workspaceId } = payload;
  const shared = useSharedModel({ workspaceId, filePath });
  // A file the editor cannot load as editable text (binary, missing,
  // read-only) falls back to the read-only snapshot read from disk.
  const model = shared.phase === "ready" && !shared.readOnly ? shared.model : null;
  const working = useMemo<WorkingSide | null>(
    () => (model ? { model, input: { workspaceId, filePath } } : null),
    [model, workspaceId, filePath],
  );
  return (
    <DiffView
      tabId={tabId}
      payload={payload}
      working={working}
      workingPending={shared.phase === "loading"}
    />
  );
}

function DiffView({
  tabId,
  payload,
  working,
  workingPending,
}: {
  tabId: string;
  payload: DiffTabPayload;
  /** The side the diff edits, or null when it is read-only. */
  working: WorkingSide | null;
  workingPending: boolean;
}) {
  const { t } = useTranslation();
  const { left, right, status, reload } = useDiffContent(payload);
  const showRefreshing = useDelayedRefreshing(status);
  const monacoTheme = useMonacoThemeName();
  // @monaco-editor/react가 monaco를 lazy 로딩하는 동안에는 null.
  const monaco = useMonaco();
  const leftContent = readyContentFor(left);
  const rightContent = readyContentFor(right);
  const blocking = blockingPlaceholder(left, right, leftContent, rightContent);
  const { workspaceId, relPath, oldRelPath, leftRef, rightRef } = payload;
  // A side git does not have shows as an empty file; staging lines of it
  // would write an empty file rather than add or remove one.
  const placeholderSide = !!leftContent?.placeholder || !!rightContent?.placeholder;
  const staging = useMemo<DiffStaging | null>(() => {
    if (placeholderSide) return null;
    if (leftRef === "INDEX" && rightRef === "WORKING") return { kind: "stage", workspaceId, relPath };
    if (rightRef === "INDEX" && leftRef !== EMPTY_TREE) {
      return { kind: "unstage", workspaceId, relPath, headRelPath: oldRelPath ?? relPath };
    }
    return null;
  }, [placeholderSide, leftRef, rightRef, workspaceId, relPath, oldRelPath]);

  if (blocking) {
    return (
      <DiffShell left={left} right={right} showRefreshing={showRefreshing} onReload={reload}>
        <EmptyState title={blocking.title} description={blocking.description} tone="status" className="min-h-0" />
      </DiffShell>
    );
  }

  if (!leftContent || !rightContent || workingPending || !monaco) {
    const title =
      leftContent && rightContent && !monaco
        ? t("editor.loading_monaco")
        : t("editor.loading_diff");
    return (
      <DiffShell left={left} right={right} showRefreshing={showRefreshing} onReload={reload}>
        <EmptyState title={title} tone="status" className="min-h-0" />
      </DiffShell>
    );
  }

  return (
    <DiffShell left={left} right={right} showRefreshing={showRefreshing} onReload={reload}>
      <MissingContentNotice side="left" content={leftContent} />
      {!working && <MissingContentNotice side="right" content={rightContent} />}
      <div className="min-h-0 flex-1">
        <DiffEditorHost
          tabId={tabId}
          monaco={monaco}
          theme={monacoTheme}
          original={snapshotOf(monaco, leftContent)}
          modified={snapshotOf(monaco, rightContent)}
          working={working}
          staging={staging}
        />
      </div>
    </DiffShell>
  );
}

interface DiffSideSnapshot {
  content: string;
  language: string;
  /** Model URI path (`/…`); keeps the file extension for syntax detection. */
  path: string;
}

/**
 * Snapshot of one side. Monaco's model language is resolved from the path
 * here: an empty language would leave the side as plain text.
 */
function snapshotOf(monaco: typeof Monaco, content: DiffSideReadyState): DiffSideSnapshot {
  return {
    content: content.content,
    language: languageIdForPath(monaco, content.request.relPath) ?? "plaintext",
    path: modelPathFor(content),
  };
}

/**
 * Owns the Monaco diff editor and its snapshot models. The working model,
 * when given, belongs to the model cache: the editor shows and edits it but
 * never disposes it.
 */
function DiffEditorHost({
  tabId,
  monaco,
  theme,
  original,
  modified,
  working,
  staging,
}: {
  tabId: string;
  monaco: typeof Monaco;
  theme: string;
  original: DiffSideSnapshot;
  modified: DiffSideSnapshot;
  working: WorkingSide | null;
  staging: DiffStaging | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [editor, setEditor] = useState<Monaco.editor.IStandaloneDiffEditor | null>(null);
  const [instanceId] = useState(() => ++nextDiffEditorId);
  const ownedRef = useRef<SnapshotModels>({ original: null, modified: null });
  // The editor's own reference to the working model's cache entry, held while
  // it shows the model. The owner's release runs first when the tab closes
  // (React cleans up a parent before its children), and the cache disposing
  // a model the widget still shows throws.
  const heldRef = useRef<EditorInput | null>(null);
  const workingModel = working?.model ?? null;
  const workingInput = working?.input ?? null;
  const { content: originalContent, language: originalLanguage, path: originalPath } = original;
  const { content: modifiedContent, language: modifiedLanguage, path: modifiedPath } = modified;

  // Declared before the editor's creation so that on unmount it comes off
  // while the editor is still alive: React runs cleanups in this order.
  useEffect(() => {
    if (!editor || !staging) return;
    const installed = installDiffStaging(editor, monaco, staging);
    return () => installed.dispose();
  }, [editor, monaco, staging]);

  // The theme only seeds creation; the effect below follows it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const created = monaco.editor.createDiffEditor(container, { ...diffEditorOptions, theme });
    setEditor(created);
    return () => {
      // Detach the models before disposing them, the order microsoft/vscode#222197
      // settled on; disposing a model the widget still shows throws.
      created.setModel(null);
      created.dispose();
      ownedRef.current.original?.dispose();
      ownedRef.current.modified?.dispose();
      ownedRef.current = { original: null, modified: null };
      if (heldRef.current) releaseModel(heldRef.current);
      heldRef.current = null;
      setEditor(null);
    };
  }, [monaco]);

  useEffect(() => {
    monaco.editor.setTheme(theme);
  }, [monaco, theme]);

  useEffect(() => {
    if (!editor) return;
    const owned = ownedRef.current;
    const stale: Monaco.editor.ITextModel[] = [];
    const originalModel = syncSnapshotModel(
      monaco,
      owned,
      "original",
      { content: originalContent, language: originalLanguage, path: originalPath },
      instanceId,
      stale,
    );
    const modifiedModel =
      workingModel ??
      syncSnapshotModel(
        monaco,
        owned,
        "modified",
        { content: modifiedContent, language: modifiedLanguage, path: modifiedPath },
        instanceId,
        stale,
      );
    if (workingModel && owned.modified) {
      stale.push(owned.modified);
      owned.modified = null;
    }

    const held = heldRef.current;
    const holdChanged = !sameInput(held, workingInput);
    if (holdChanged && workingInput) {
      heldRef.current = workingInput;
      // The entry is loaded, so this only counts the reference; a failure has
      // already dropped it.
      acquireModel(workingInput).catch(() => {
        if (heldRef.current === workingInput) heldRef.current = null;
      });
    }

    const current = editor.getModel();
    if (current?.original !== originalModel || current?.modified !== modifiedModel) {
      editor.setModel({ original: originalModel, modified: modifiedModel });
    }
    editor.updateOptions({ readOnly: workingModel === null });
    for (const model of stale) model.dispose();
    if (holdChanged) {
      if (held) releaseModel(held);
      if (!workingInput) heldRef.current = null;
    }
  }, [
    editor,
    monaco,
    instanceId,
    originalContent,
    originalLanguage,
    originalPath,
    modifiedContent,
    modifiedLanguage,
    modifiedPath,
    workingModel,
    workingInput,
  ]);

  useEffect(() => {
    if (!editor) return;
    return registerTabFocusTarget(tabId, () => editor.getModifiedEditor().focus());
  }, [editor, tabId]);

  return <div ref={containerRef} className="h-full w-full" />;
}

function sameInput(a: EditorInput | null, b: EditorInput | null): boolean {
  return a?.workspaceId === b?.workspaceId && a?.filePath === b?.filePath;
}

interface SnapshotModels {
  original: Monaco.editor.ITextModel | null;
  modified: Monaco.editor.ITextModel | null;
}

/**
 * Brings the snapshot model of `side` up to date with `snapshot`, creating
 * one for a new path. A replaced model goes to `stale`, to be disposed once
 * the editor no longer shows it.
 */
function syncSnapshotModel(
  monaco: typeof Monaco,
  owned: SnapshotModels,
  side: keyof SnapshotModels,
  snapshot: DiffSideSnapshot,
  instanceId: number,
  stale: Monaco.editor.ITextModel[],
): Monaco.editor.ITextModel {
  // Two diff tabs of the same sides each own their models.
  const uri = monaco.Uri.parse(`nexus-diff:///${instanceId}${snapshot.path}`);
  const current = owned[side];
  if (current && current.uri.toString() === uri.toString()) {
    if (current.getLanguageId() !== snapshot.language) {
      monaco.editor.setModelLanguage(current, snapshot.language);
    }
    if (current.getValue() !== snapshot.content) current.setValue(snapshot.content);
    return current;
  }
  if (current) stale.push(current);
  const created = monaco.editor.createModel(snapshot.content, snapshot.language, uri);
  owned[side] = created;
  return created;
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
  const { t } = useTranslation();
  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-border bg-muted px-3 text-app-ui-sm">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <SideLabel label={t("editor.left")} state={left} />
          <span className="text-muted-foreground">→</span>
          <SideLabel label={t("editor.right")} state={right} />
        </div>
        <div className="flex shrink-0 items-center gap-2 text-muted-foreground">
          {showRefreshing && <span>{t("editor.refreshing")}</span>}
          <Button type="button" variant="ghost" size="sm" onClick={onReload}>
            {t("editor.reload")}
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
  const { t } = useTranslation();
  if (content.placeholder !== "missing") return null;
  const label = side === "left" ? t("editor.left_missing") : t("editor.right_missing");
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
        `${side.request.side === "left" ? i18next.t("editor.left") : i18next.t("editor.right")}: ${side.request.relPath} (${formatBytes(side.sizeBytes)})`,
    )
    .join("\n");

  return { title: i18next.t("editor.no_display_binary"), description };
}

/**
 * Builds a stable Monaco model URI path that preserves the file extension for
 * syntax detection.
 */
function modelPathFor(content: DiffSideReadyState): string {
  const encodedPath = content.request.relPath.split("/").map(encodeURIComponent).join("/");
  return `/${encodeURIComponent(content.request.workspaceId)}/${content.request.side}/${encodeURIComponent(content.request.ref)}/${encodedPath}`;
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
