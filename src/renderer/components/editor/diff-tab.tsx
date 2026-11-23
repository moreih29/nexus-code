import { useMonaco } from "@monaco-editor/react";
import i18next from "i18next";
import type * as Monaco from "monaco-editor";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fontFamily, typeScale } from "../../../shared/design-tokens";
import type { DiffTabPayload } from "../../../shared/types/tab";
import { useBannerDismissal } from "../../hooks/use-banner-dismissal";
import { useMonacoThemeName } from "../../hooks/use-monaco-theme-name";
import {
  type DiffStaging,
  installDiffStaging,
} from "../../services/editor/git/staging/diff-editor-staging";
import { acquireModel, releaseModel, useSharedModel } from "../../services/editor/model";
import { useDiffWorkingFile } from "../../services/editor/tabs";
import type { EditorInput } from "../../services/editor/types";
import { registerTabFocusTarget } from "../../services/tab-focus";
import { formatBytes } from "../../utils/format-bytes";
import { type BannerDismiss, BannerDismissButton } from "../ui/banner";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
import {
  type DiffContentStatus,
  type DiffSideReadyState,
  type DiffSideState,
  REFRESHING_INDICATOR_DELAY_MS,
  readyContentFor,
  useDiffContent,
} from "./diff-content-loader";
import { EMPTY_TREE } from "./diff-refs";
import { languageIdForPath } from "./language-id-for-path";

const diffEditorOptions = {
  readOnly: true,
  originalEditable: false,
  renderSideBySide: true,
  useInlineViewWhenSpaceIsLimited: false,
  minimap: { enabled: false },
  fontSize: typeScale.codeBody.fontSize,
  fontFamily: fontFamily.monoBody,
  scrollBeyondLastLine: false,
  automaticLayout: true,
} satisfies Monaco.editor.IDiffEditorConstructionOptions;

(diffEditorOptions as Record<string, unknown>)["semanticHighlighting.enabled"] = true;

let nextDiffEditorId = 0;

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

export function DiffTab({ tabId, ...payload }: DiffTabProps) {
  const workingFile = useDiffWorkingFile(payload);
  return workingFile ? (
    <WorkingTreeDiff key={workingFile} tabId={tabId} payload={payload} filePath={workingFile} />
  ) : (
    <DiffView tabId={tabId} payload={payload} working={null} workingPending={false} />
  );
}

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
  working: WorkingSide | null;
  workingPending: boolean;
}) {
  const { t } = useTranslation();
  const { left, right, status, reload } = useDiffContent(payload);
  const showRefreshing = useDelayedRefreshing(status);
  const monacoTheme = useMonacoThemeName();
  const monaco = useMonaco();
  const leftContent = readyContentFor(left);
  const rightContent = readyContentFor(right);
  const blocking = blockingPlaceholder(left, right, leftContent, rightContent);
  const { workspaceId, relPath, oldRelPath, leftRef, rightRef } = payload;
  const leftNotice = useBannerDismissal(
    ["diff-missing", workspaceId, tabId, "left", oldRelPath ?? relPath, leftRef],
    leftContent?.placeholder === "missing" ? [true] : undefined,
    true,
  );
  const rightNotice = useBannerDismissal(
    ["diff-missing", workspaceId, tabId, "right", relPath, rightRef],
    rightContent?.placeholder === "missing" ? [true] : undefined,
    true,
  );
  const placeholderSide = !!leftContent?.placeholder || !!rightContent?.placeholder;
  const staging = useMemo<DiffStaging | null>(() => {
    if (placeholderSide) return null;
    if (leftRef === "INDEX" && rightRef === "WORKING")
      return { kind: "stage", workspaceId, relPath };
    if (rightRef === "INDEX" && leftRef !== EMPTY_TREE) {
      return { kind: "unstage", workspaceId, relPath, headRelPath: oldRelPath ?? relPath };
    }
    return null;
  }, [placeholderSide, leftRef, rightRef, workspaceId, relPath, oldRelPath]);

  if (blocking) {
    return (
      <DiffShell left={left} right={right} showRefreshing={showRefreshing} onReload={reload}>
        <EmptyState
          title={blocking.title}
          description={blocking.description}
          tone="status"
          className="min-h-0"
        />
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
      {leftContent.placeholder === "missing" && !leftNotice.dismissed && (
        <MissingContentNotice side="left" dismiss={leftNotice.dismiss} />
      )}
      {!working && rightContent.placeholder === "missing" && !rightNotice.dismissed && (
        <MissingContentNotice side="right" dismiss={rightNotice.dismiss} />
      )}
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
  path: string;
}

function snapshotOf(monaco: typeof Monaco, content: DiffSideReadyState): DiffSideSnapshot {
  return {
    content: content.content,
    language: languageIdForPath(monaco, content.request.relPath) ?? "plaintext",
    path: modelPathFor(content),
  };
}

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
  const heldRef = useRef<EditorInput | null>(null);
  const workingModel = working?.model ?? null;
  const workingInput = working?.input ?? null;
  const { content: originalContent, language: originalLanguage, path: originalPath } = original;
  const { content: modifiedContent, language: modifiedLanguage, path: modifiedPath } = modified;

  useEffect(() => {
    if (!editor || !staging) return;
    const installed = installDiffStaging(editor, monaco, staging);
    return () => installed.dispose();
  }, [editor, monaco, staging]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const created = monaco.editor.createDiffEditor(container, { ...diffEditorOptions, theme });
    setEditor(created);
    return () => {
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

function syncSnapshotModel(
  monaco: typeof Monaco,
  owned: SnapshotModels,
  side: keyof SnapshotModels,
  snapshot: DiffSideSnapshot,
  instanceId: number,
  stale: Monaco.editor.ITextModel[],
): Monaco.editor.ITextModel {
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
  showRefreshing: boolean;
  onReload: () => void;
  children: ReactNode;
}

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

function MissingContentNotice({
  side,
  dismiss,
}: {
  side: "left" | "right";
  dismiss: BannerDismiss;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted px-3 py-1 text-app-ui-sm text-muted-foreground">
      <span className="flex-1">
        {side === "left" ? t("editor.left_missing") : t("editor.right_missing")}
      </span>
      <BannerDismissButton dismiss={dismiss} className="-my-0.5" />
    </div>
  );
}

interface BlockingPlaceholder {
  title: string;
  description?: string;
}

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

function modelPathFor(content: DiffSideReadyState): string {
  const encodedPath = content.request.relPath.split("/").map(encodeURIComponent).join("/");
  return `/${encodeURIComponent(content.request.workspaceId)}/${content.request.side}/${encodeURIComponent(content.request.ref)}/${encodedPath}`;
}
