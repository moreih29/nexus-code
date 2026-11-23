import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ClaudeTabView } from "@/components/chat/claude-tab";
import { CodexTabView } from "@/components/chat/codex-tab";
import { CommitTab } from "@/components/editor/commit-tab";
import { DiffTab } from "@/components/editor/diff-tab";
import { sessionKey } from "@/services/agent-sessions/model";
import { leafShowing } from "@/services/agent-view/layout";
import { reconcileWatchedModel } from "@/services/editor/model/cache";
import { isDocxFile } from "@/services/editor/preview/docx";
import { isFontFile } from "@/services/editor/preview/font";
import { mediaKindFor } from "@/services/editor/preview/media";
import { isPdfFile } from "@/services/editor/preview/pdf";
import { isPresentationFile } from "@/services/editor/preview/pptx";
import { isImageFile } from "@/services/editor/preview/previewable";
import { isSpreadsheetFile } from "@/services/editor/preview/spreadsheet";
import { retainPanelDirectoryWatch } from "@/state/operations/files";
import { useAgentViewStore } from "@/state/stores/agent-view";
import { type Tab, useTabsStore } from "@/state/stores/tabs";
import { useWorkspacesStore } from "@/state/stores/workspaces";
import { relPath } from "@/utils/path";
import { NoteTab } from "../../notes/note-tab";
import { BrowserTabView } from "./browser-view";
import { DocxEditorView } from "./docx-editor-view";
import { EditorView, ImageEditorView } from "./editor-view";
import { FontEditorView } from "./font-editor-view";
import { MediaEditorView } from "./media-editor-view";
import { movePortalTarget } from "./move-portal-target";
import { PdfEditorView } from "./pdf-editor-view";
import { PptxEditorView } from "./pptx-editor-view";
import { AGENT_VIEW_SLOTS, useSlotElement } from "./slot-registry";
import { SpreadsheetEditorView } from "./spreadsheet-editor-view";
import { useViewPark } from "./view-park";

const TerminalView = lazy(() =>
  import("./terminal-view").then(({ TerminalView }) => ({ default: TerminalView })),
);

interface ContentHostProps {
  workspaceId: string;
  tabId: string;
  ownerLeafId: string | null;
  isActiveTab: boolean;
  isWorkspaceActive: boolean;
}

export const ContentHost = memo(function ContentHost({
  workspaceId,
  tabId,
  ownerLeafId,
  isActiveTab,
  isWorkspaceActive,
}: ContentHostProps) {
  const tab = useTabsStore((s) => s.byWorkspace[workspaceId]?.[tabId]);
  const agentLeafId = useAgentViewStore((s) =>
    s.mode === "agents" ? leafShowing(s.root, sessionKey(workspaceId, tabId)) : undefined,
  );
  const inAgentView = agentLeafId !== undefined;
  const placedLeafId = inAgentView ? agentLeafId : ownerLeafId;
  const slotEl = useSlotElement(inAgentView ? AGENT_VIEW_SLOTS : workspaceId, placedLeafId);
  const parkEl = useViewPark();
  const isVisible = inAgentView ? agentLeafId !== null : isActiveTab && isWorkspaceActive;
  const currentParent = isVisible ? (slotEl ?? parkEl) : parkEl;

  const panelFilePath =
    agentLeafId && tab?.type === "editor" && tab.props.origin !== "external"
      ? tab.props.filePath
      : null;
  const workspaceRoot = useWorkspacesStore((s) =>
    panelFilePath ? s.workspaces.find((w) => w.id === workspaceId)?.rootPath : undefined,
  );
  useEffect(() => {
    if (!panelFilePath || !workspaceRoot) return;
    const file = relPath(panelFilePath, workspaceRoot);
    if (!file || file === panelFilePath) return;
    const dir = file.slice(0, Math.max(0, file.lastIndexOf("/")));
    const watch = retainPanelDirectoryWatch(workspaceId, dir);
    let live = true;
    void watch.ready.then((ready) => {
      if (live && ready) return reconcileWatchedModel({ workspaceId, filePath: panelFilePath });
    });
    return () => {
      live = false;
      watch.release();
    };
  }, [panelFilePath, workspaceId, workspaceRoot]);

  const [shown, setShown] = useState(isVisible);
  if (isVisible && !shown) setShown(true);
  const deferred = !shown && tab !== undefined && builtWhenShown(tab);

  const portalTargetRef = useRef<HTMLDivElement | null>(null);
  if (portalTargetRef.current === null) {
    const el = document.createElement("div");
    el.style.position = "absolute";
    el.style.inset = "0";
    el.style.isolation = "isolate";
    portalTargetRef.current = el;
  }
  const portalTarget = portalTargetRef.current;

  useEffect(() => {
    if (!currentParent) return;
    if (portalTarget.parentElement !== currentParent) {
      movePortalTarget(currentParent, portalTarget);
    }
  }, [currentParent, portalTarget]);

  useEffect(() => {
    return () => {
      portalTarget.remove();
    };
  }, [portalTarget]);

  const placed = tab?.type === "terminal" || tab?.type === "browser";
  const leafId = placed ? placedLeafId : null;
  const parentEl = placed ? currentParent : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: what the view reads of the tab
  const viewTab = useMemo(() => tab, [tab?.id, tab?.type, tab?.props]);

  const inner = useMemo(() => {
    const tab = viewTab;
    if (!tab || deferred) return null;
    const mediaKind = tab.type === "editor" ? mediaKindFor(tab.props.filePath) : null;
    return (
      <div className="absolute inset-0">
        {tab.type === "terminal" ? (
          <Suspense fallback={null}>
            <TerminalView
              workspaceId={workspaceId}
              tabId={tab.id}
              cwd={tab.props.cwd}
              ownerLeafId={leafId}
              parentEl={parentEl}
              isVisible={isVisible}
            />
          </Suspense>
        ) : tab.type === "editor" ? (
          isImageFile(tab.props.filePath) ? (
            <ImageEditorView
              key={tab.props.filePath}
              filePath={tab.props.filePath}
              workspaceId={workspaceId}
            />
          ) : mediaKind ? (
            <MediaEditorView
              tabId={tab.id}
              key={tab.props.filePath}
              filePath={tab.props.filePath}
              workspaceId={workspaceId}
              kind={mediaKind}
            />
          ) : isFontFile(tab.props.filePath) ? (
            <FontEditorView
              key={tab.props.filePath}
              filePath={tab.props.filePath}
              workspaceId={workspaceId}
            />
          ) : isPdfFile(tab.props.filePath) ? (
            <PdfEditorView
              key={tab.props.filePath}
              filePath={tab.props.filePath}
              workspaceId={workspaceId}
            />
          ) : isSpreadsheetFile(tab.props.filePath) ? (
            <SpreadsheetEditorView
              key={tab.props.filePath}
              filePath={tab.props.filePath}
              workspaceId={workspaceId}
            />
          ) : isDocxFile(tab.props.filePath) ? (
            <DocxEditorView
              key={tab.props.filePath}
              filePath={tab.props.filePath}
              workspaceId={workspaceId}
            />
          ) : isPresentationFile(tab.props.filePath) ? (
            <PptxEditorView
              key={tab.props.filePath}
              filePath={tab.props.filePath}
              workspaceId={workspaceId}
            />
          ) : (
            <EditorView
              key={tab.props.filePath}
              tabId={tab.id}
              filePath={tab.props.filePath}
              workspaceId={workspaceId}
              origin={tab.props.origin}
            />
          )
        ) : tab.type === "untitled" ? (
          <EditorView
            key={`untitled-${tab.props.untitledIndex}`}
            tabId={tab.id}
            filePath={`Untitled-${tab.props.untitledIndex}`}
            workspaceId={workspaceId}
            origin="untitled"
          />
        ) : tab.type === "editor.diff" ? (
          <DiffTab tabId={tab.id} {...tab.props} />
        ) : tab.type === "git.commit" ? (
          <CommitTab workspaceId={workspaceId} sha={tab.props.sha} tabId={tab.id} />
        ) : tab.type === "browser" ? (
          <BrowserTabView
            tabId={tab.id}
            workspaceId={workspaceId}
            initialUrl={tab.props.initialUrl}
            lastUrl={tab.props.lastUrl}
            partition={tab.props.partition}
            isActive={isVisible}
            parentEl={parentEl}
          />
        ) : tab.type === "claude" ? (
          <ClaudeTabView
            workspaceId={workspaceId}
            tabId={tab.id}
            props={tab.props}
            isVisible={isVisible}
          />
        ) : tab.type === "codex" ? (
          <CodexTabView
            workspaceId={workspaceId}
            tabId={tab.id}
            props={tab.props}
            isVisible={isVisible}
          />
        ) : tab.type === "note" ? (
          <NoteTab
            workspaceId={workspaceId}
            tabId={tab.id}
            noteId={tab.props.noteId}
            isVisible={isVisible}
          />
        ) : null}
      </div>
    );
  }, [viewTab, workspaceId, isVisible, leafId, parentEl, deferred]);

  return createPortal(inner, portalTarget);
});

function builtWhenShown(tab: Tab): boolean {
  if (tab.type === "editor.diff" || tab.type === "git.commit" || tab.type === "note") return true;
  if (tab.type !== "editor") return false;
  const path = tab.props.filePath;
  return (
    isImageFile(path) ||
    mediaKindFor(path) !== null ||
    isFontFile(path) ||
    isPdfFile(path) ||
    isSpreadsheetFile(path) ||
    isDocxFile(path) ||
    isPresentationFile(path)
  );
}
