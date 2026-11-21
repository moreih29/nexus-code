// One panel of the agent view: a tab bar of the agents it holds, from any
// workspace, and below it the one in front — the very tab its workspace
// shows, moved here. Taking an agent out of the panel leaves it running.
// It holds another computer's sessions as tabs too, drawn here.

import { Columns2, Rows2, SquareArrowOutUpRight, X } from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SplitLeaf } from "@/engine";
import { fadeMask, useStripOverflow } from "@/hooks/use-strip-overflow";
import { useTabInSight } from "@/hooks/use-tab-in-sight";
import { shortcutFor } from "@/keybindings/shortcut-labels";
import { openInWorkspace } from "@/services/agent-sessions/actions";
import type { AgentSession } from "@/services/agent-sessions/model";
import { type Agents, workspaceColor } from "@/services/agent-view/agents";
import type { EndedAgent } from "@/services/agent-view/ended";
import {
  type AgentLayout,
  closeLeaf,
  isRemoteKey,
  parseSessionKey,
  placeKey,
  removeKey,
  selectKey,
  setActiveLeaf,
  splitLeaf,
} from "@/services/agent-view/layout";
import { useAgentResumeCheckpoint } from "@/services/agent-view/resume-terminal";
import { focusPanelTab } from "@/services/agent-view/show";
import { useAgentViewStore } from "@/state/stores/agent-view";
import { useRemoteTarget, useRemoteViewStore } from "@/state/stores/remote-view";
import { type EditorTab, useTabsStore } from "@/state/stores/tabs";
import { useUIStore } from "@/state/stores/ui";
import {
  rootWorkspaceId,
  selectIsWorkspaceOnline,
  selectWorkspaceConnectionStatus,
  useWorkspacesStore,
} from "@/state/stores/workspaces";
import { cn } from "@/utils/cn";
import { beginDragInFlight } from "@/utils/drag-in-flight";
import { basename } from "@/utils/path";
import { toSlashPath } from "../../../shared/fs/drive-path";
import { isRemoteFileKey, parseRemoteFileKey } from "../../../shared/fs/remote-file-key";
import { COMMANDS } from "../../../shared/keybindings/commands";
import { retryWorkspaceConnection } from "../../state/operations/workspace-selection";
import type { DropZone } from "../../types/workbench-dnd";
import { StateGlyph, stateLabel } from "../agent-list/session-status";
import { AgentMark } from "../agent-list/status-view";
import { FileIcon } from "../files/file-tree/file-icon";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
import { IconButton } from "../ui/icon-button";
import { AGENT_VIEW_SLOTS, slotRegistry } from "../workspace/content/slot-registry";
import { DropIndicator } from "../workspace/dnd/drop-indicator";
import { zoneFromCoords } from "../workspace/dnd/use-drop-target";
import { OverflowTabsMenu } from "../workspace/tabs/overflow-tabs-menu";
import { TabIcon, useTabDirty } from "../workspace/tabs/tab-item";
import {
  agentDragKey,
  insertionIndex,
  isAgentDrag,
  setAgentDrag,
  type TabInsertion,
  tabInsertion,
  ZONE_DIRECTION,
} from "./drag";
import { EndedBar } from "./ended-bar";
import { RemoteFilePane } from "./remote-file-pane";
import { RemoteSessionPane } from "./remote-pane";
import { DeviceChip, RemoteTabLabel } from "./remote-sessions";

function update(change: (layout: AgentLayout) => AgentLayout): void {
  useAgentViewStore.getState().update(change);
}

// Memo: the view renders for each change of the agents' or the layout's,
// and a panel only when its own leaf, the agents or the ended ones change.
export const AgentPane = memo(function AgentPane({
  leaf,
  agents,
  ended,
}: {
  leaf: SplitLeaf;
  agents: Agents;
  ended: ReadonlyMap<string, EndedAgent>;
}) {
  const { t } = useTranslation();
  const isActive = useAgentViewStore((s) => s.activeLeafId === leaf.id);
  const split = useAgentViewStore((s) => s.root.kind === "split");
  const lit = useAgentViewStore((s) => s.hoveredKey !== null && leaf.tabIds.includes(s.hoveredKey));
  const front = leaf.activeTabId !== null ? parseSessionKey(leaf.activeTabId) : null;
  const frontFile = leaf.activeTabId !== null ? parseRemoteFileKey(leaf.activeTabId) : null;
  const frontEnded = leaf.activeTabId !== null ? ended.get(leaf.activeTabId) : undefined;
  const frontKind = useTabsStore((s) =>
    front ? s.byWorkspace[front.workspaceId]?.[front.tabId]?.type : undefined,
  );
  const viewShown = useAgentViewStore((s) => s.mode === "agents");
  const frontAgent = leaf.activeTabId !== null ? agents.byKey.get(leaf.activeTabId) : undefined;
  const resumeCheckpoint = useAgentResumeCheckpoint(viewShown ? frontAgent?.session : undefined);

  const slotElRef = useRef<HTMLElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const findTab = (strip: HTMLElement, key: string) =>
    strip.querySelector(`[data-agent-tab="${CSS.escape(key)}"]`);
  useTabInSight(stripRef, leaf.activeTabId, (strip) => findTab(strip, leaf.activeTabId ?? ""));
  const overflow = useStripOverflow(stripRef, leaf.tabIds, findTab);
  const slotRef = useCallback(
    (el: HTMLElement | null) => {
      slotElRef.current = el;
      slotRegistry.set(AGENT_VIEW_SLOTS, leaf.id, el);
    },
    [leaf.id],
  );

  // Native listeners: the content is portaled in, so its events reach this
  // panel through the DOM, not through React (as in a workspace's group).
  const [outerEl, setOuterEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!outerEl) return;
    const activate = () => update((layout) => setActiveLeaf(layout, leaf.id));
    // A click into an iframe (an HTML preview) moves focus out of the window.
    const onWindowBlur = () => {
      const active = document.activeElement;
      if (active?.tagName === "IFRAME" && outerEl.contains(active)) activate();
    };
    outerEl.addEventListener("focusin", activate);
    outerEl.addEventListener("mousedown", activate);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      outerEl.removeEventListener("focusin", activate);
      outerEl.removeEventListener("mousedown", activate);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [outerEl, leaf.id]);

  const [dropZone, setDropZone] = useState<DropZone | null>(null);
  // Over the tab bar a drag shows where among the tabs it goes, as a
  // workspace's tab bar does; over the content, which part of the panel.
  const [insertion, setInsertion] = useState<TabInsertion | null>(null);
  useEffect(() => {
    if (!outerEl) return;
    // Every element the drag passes enters and leaves; it left the panel
    // once the count is back to none.
    let depth = 0;
    const reset = () => {
      depth = 0;
      setDropZone(null);
      setInsertion(null);
    };
    const zoneOf = (e: DragEvent): DropZone => {
      const slot = slotElRef.current;
      return slot ? zoneFromCoords(slot.getBoundingClientRect(), e.clientX, e.clientY) : "center";
    };
    /** Where among the tabs the drag goes, when it is over the tab bar. */
    const insertionOf = (e: DragEvent): TabInsertion | null => {
      const bar = barRef.current;
      const strip = stripRef.current;
      if (!bar || !strip) return null;
      const r = bar.getBoundingClientRect();
      const over =
        e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom;
      return over ? tabInsertion(strip, e.clientX) : null;
    };
    const onEnter = (e: DragEvent) => {
      if (!isAgentDrag(e.dataTransfer)) return;
      depth++;
      e.preventDefault();
    };
    const onOver = (e: DragEvent) => {
      if (!isAgentDrag(e.dataTransfer)) return;
      // Ahead of the content's own drop handling (a terminal takes files).
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const next = insertionOf(e);
      setInsertion((prev) =>
        prev && next && prev.x === next.x && prev.before === next.before ? prev : next,
      );
      const zone = next ? null : zoneOf(e);
      setDropZone((prev) => (prev === zone ? prev : zone));
    };
    const onLeave = (e: DragEvent) => {
      if (!isAgentDrag(e.dataTransfer)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        setDropZone(null);
        setInsertion(null);
      }
    };
    const onDrop = (e: DragEvent) => {
      if (!isAgentDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      const key = agentDragKey(e.dataTransfer);
      const at = insertionOf(e);
      const zone = zoneOf(e);
      reset();
      if (
        key === null ||
        (isRemoteFileKey(key) && !useAgentViewStore.getState().remoteFiles.has(key))
      ) {
        return;
      }
      // On the tab bar: where its line showed. On the content: an edge splits
      // the panel toward it, the middle puts the agent last.
      update((layout) =>
        at
          ? placeKey(layout, key, leaf.id, undefined, insertionIndex(leaf.tabIds, key, at.before))
          : placeKey(layout, key, leaf.id, zone === "center" ? undefined : ZONE_DIRECTION[zone]),
      );
      focusPanelTab(key);
    };
    outerEl.addEventListener("dragenter", onEnter, true);
    outerEl.addEventListener("dragover", onOver, true);
    outerEl.addEventListener("dragleave", onLeave, true);
    outerEl.addEventListener("drop", onDrop, true);
    window.addEventListener("dragend", reset);
    return () => {
      outerEl.removeEventListener("dragenter", onEnter, true);
      outerEl.removeEventListener("dragover", onOver, true);
      outerEl.removeEventListener("dragleave", onLeave, true);
      outerEl.removeEventListener("drop", onDrop, true);
      window.removeEventListener("dragend", reset);
    };
  }, [outerEl, leaf.id, leaf.tabIds]);

  const select = (key: string) => {
    update((layout) => selectKey(layout, leaf.id, key));
    focusPanelTab(key);
  };
  const remove = (key: string) => update((layout) => removeKey(layout, key));
  const splitTo = (direction: "right" | "down") =>
    update((layout) => splitLeaf(layout, leaf.id, direction));

  // When every agent here is from one workspace, its chip is shown once,
  // ahead of the tabs, instead of on each of them.
  const workspaceIds = new Set(leaf.tabIds.map((key) => parseSessionKey(key)?.workspaceId));
  const [onlyWorkspace] = workspaceIds;
  const sharedWorkspace = workspaceIds.size === 1 ? onlyWorkspace : undefined;
  // So with another computer's sessions, when they are all this panel holds.
  const sharedDevice = useRemoteViewStore((s) => {
    const targets = leaf.tabIds.map((key) => s.targets.get(key));
    const first = targets[0];
    return first && targets.every((t) => t?.deviceId === first.deviceId)
      ? first.deviceName
      : undefined;
  });

  return (
    <div
      ref={setOuterEl}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-(--radius-island) island-surface"
      data-testid="agent-pane"
      data-leaf-id={leaf.id}
    >
      <div ref={barRef} className="flex h-9 shrink-0 items-center gap-1 overflow-hidden px-1.5">
        {sharedWorkspace && <WorkspaceChip workspaceId={sharedWorkspace} className="ml-1" />}
        {sharedDevice !== undefined && <DeviceChip name={sharedDevice} className="ml-1" />}
        <div
          ref={stripRef}
          className="relative flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{ maskImage: fadeMask(overflow) }}
        >
          {leaf.tabIds.map((key) =>
            isRemoteKey(key) ? (
              <RemoteTab
                key={key}
                sessionKey={key}
                active={key === leaf.activeTabId}
                showDevice={sharedDevice === undefined}
                onSelect={() => select(key)}
                onRemove={() => remove(key)}
              />
            ) : isRemoteFileKey(key) ? (
              <RemoteFileTab
                key={key}
                fileKey={key}
                active={key === leaf.activeTabId}
                onSelect={() => select(key)}
                onRemove={() => remove(key)}
              />
            ) : (
              <AgentTab
                key={key}
                sessionKey={key}
                agents={agents}
                active={key === leaf.activeTabId}
                showWorkspace={sharedWorkspace === undefined}
                onSelect={() => select(key)}
                onRemove={() => remove(key)}
              />
            ),
          )}
          {insertion && (
            <div
              aria-hidden
              className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-primary"
              style={{ left: insertion.x, transform: "translateX(-1px)" }}
            />
          )}
        </div>
        <OverflowTabsMenu
          hidden={overflow.hidden}
          renderTab={(key) =>
            isRemoteKey(key) ? (
              <RemoteTabFace sessionKey={key} showDevice={sharedDevice === undefined} />
            ) : isRemoteFileKey(key) ? (
              <RemoteFileTabFace fileKey={key} />
            ) : (
              <AgentTabLabel
                sessionKey={key}
                agents={agents}
                showWorkspace={sharedWorkspace === undefined}
              />
            )
          }
          onSelect={select}
        />
        <div className="flex shrink-0 items-center gap-0.5">
          {front && (
            <IconButton label={t(goToTabLabel(frontKind))} onClick={() => openInWorkspace(front)}>
              <SquareArrowOutUpRight aria-hidden className="size-3.5" />
            </IconButton>
          )}
          <IconButton
            label={t("tabBar.split_right")}
            shortcut={shortcutFor(COMMANDS.groupSplitRight)}
            onClick={() => splitTo("right")}
          >
            <Columns2 aria-hidden className="size-3.5" />
          </IconButton>
          <IconButton
            label={t("tabBar.split_down")}
            shortcut={shortcutFor(COMMANDS.groupSplitDown)}
            onClick={() => splitTo("down")}
          >
            <Rows2 aria-hidden className="size-3.5" />
          </IconButton>
          {(split || leaf.tabIds.length > 0) && (
            <IconButton
              label={t("agentView.pane.close")}
              shortcut={shortcutFor(COMMANDS.groupClose)}
              onClick={() => update((layout) => closeLeaf(layout, leaf.id))}
            >
              <X aria-hidden className="size-3.5" />
            </IconButton>
          )}
        </div>
      </div>

      {/* Where the front agent's tab is moved in (see ContentHost). */}
      <div ref={slotRef} data-agent-slot={leaf.id} className="relative min-h-0 min-w-0 flex-1">
        {leaf.tabIds.length === 0 && <EmptyPane />}
        {front && <OfflinePane workspaceId={front.workspaceId} />}
        {viewShown && frontFile && <RemoteFilePane key={leaf.activeTabId} file={frontFile} />}
        {/* Each kept while its tab is in the panel, as a chat here is: its draft,
            drawer and goal stay its own. Only the front one is read. */}
        {leaf.tabIds.filter(isRemoteKey).map((key) => (
          <RemotePaneHost
            key={key}
            sessionKey={key}
            front={key === leaf.activeTabId}
            viewShown={viewShown}
          />
        ))}
        {dropZone && <DropIndicator zone={dropZone} />}
      </div>
      {frontKind === "terminal" && front && frontEnded && (
        <EndedBar
          ended={frontEnded}
          terminal={front}
          checkpoint={resumeCheckpoint(front.tabId, frontEnded.agent)}
        />
      )}

      {/* The panel of the agent the pointer is on in the list. */}
      {lit && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-20 rounded-(--radius-island) border-2 border-dashed border-[var(--state-selected-indicator)]"
        />
      )}
      {/* The veil of a panel the keyboard is not in, as a workspace's groups have. */}
      {split && !isActive && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[var(--surface-island-inactive-veil)]"
        />
      )}
    </div>
  );
});

/** The workspace an agent is from: its name, with its color's dot. */
function WorkspaceChip({ workspaceId, className }: { workspaceId: string; className?: string }) {
  const name = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.name);
  const rootId = useWorkspacesStore((s) => rootWorkspaceId(s.workspaces, workspaceId));
  const color = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === rootId)?.color);
  return (
    <span
      className={cn(
        "flex max-w-24 min-w-0 items-center gap-1 overflow-hidden rounded-full border border-border px-1.5 text-app-micro whitespace-nowrap text-muted-foreground",
        className,
      )}
    >
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full"
        style={{ background: workspaceColor(rootId, color) }}
      />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** What a local tab shows, or null once its tab is gone. */
function useLocalTabInfo(key: string, agents: Agents) {
  const ref = parseSessionKey(key);
  const tab = useTabsStore((s) => (ref ? s.byWorkspace[ref.workspaceId]?.[ref.tabId] : undefined));
  const workspaceName = useWorkspacesStore((s) =>
    ref ? s.workspaces.find((w) => w.id === ref.workspaceId)?.name : undefined,
  );
  if (!ref || !tab) return null;
  if (tab.type === "editor") return { kind: "file" as const, ref, tab };
  if (tab.type !== "claude" && tab.type !== "codex" && tab.type !== "terminal") return null;
  const session = agents.byKey.get(key)?.session;
  const mark: AgentSession = session ?? {
    key,
    workspaceId: ref.workspaceId,
    tabId: ref.tabId,
    title: tab.title,
    kind: tab.type,
    agent: undefined,
    state: "idle",
    phase: "idle",
    estimated: false,
    since: undefined,
    message: undefined,
    prompt: undefined,
  };
  return {
    kind: "agent" as const,
    ref,
    session,
    mark,
    title: session?.title ?? tab.title,
    workspaceName,
  };
}

/**
 * An agent's workspace chip (unless the panel shows it once for all), mark,
 * title and state: its tab's face, and its row in the overflow menu.
 */
function AgentTabLabel({
  sessionKey,
  agents,
  showWorkspace,
}: {
  sessionKey: string;
  agents: Agents;
  showWorkspace: boolean;
}) {
  const info = useLocalTabInfo(sessionKey, agents);
  if (!info) return null;
  if (info.kind === "file") return <EditorTabLabel tab={info.tab} showWorkspace={showWorkspace} />;
  const { ref, session, mark, title } = info;
  return (
    <>
      {showWorkspace && <WorkspaceChip workspaceId={ref.workspaceId} />}
      <AgentMark session={mark} />
      <span className="min-w-0 truncate">{title}</span>
      {session && session.phase !== "idle" && (
        <span role="img" aria-label={stateLabel(session)} className="inline-flex shrink-0">
          <StateGlyph state={session.state} />
        </span>
      )}
    </>
  );
}

function EditorTabLabel({ tab, showWorkspace }: { tab: EditorTab; showWorkspace: boolean }) {
  const dirty = useTabDirty(tab);
  return (
    <>
      {showWorkspace && <WorkspaceChip workspaceId={tab.props.workspaceId} />}
      <TabIcon tab={tab} />
      <span className="min-w-0 truncate">{basename(tab.props.filePath)}</span>
      {dirty && (
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-[var(--tab-modified-dot)]" />
      )}
    </>
  );
}

function AgentTab({
  sessionKey: key,
  agents,
  active,
  showWorkspace,
  onSelect,
  onRemove,
}: {
  sessionKey: string;
  agents: Agents;
  active: boolean;
  /** Off when the panel shows the one workspace of all its agents. */
  showWorkspace: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const info = useLocalTabInfo(key, agents);
  if (!info) return null;
  const title =
    info.kind === "file"
      ? info.tab.props.filePath
      : info.workspaceName
        ? `${info.title} · ${info.workspaceName}`
        : info.title;
  return (
    <PanelTab
      sessionKey={key}
      active={active}
      title={title}
      file={info.kind === "file"}
      onSelect={onSelect}
      onRemove={onRemove}
    >
      <AgentTabLabel sessionKey={key} agents={agents} showWorkspace={showWorkspace} />
    </PanelTab>
  );
}

function RemoteFileTabFace({ fileKey }: { fileKey: string }) {
  const name = useAgentViewStore((s) => s.remoteFiles.get(fileKey)?.deviceName);
  const file = parseRemoteFileKey(fileKey);
  if (!file || name === undefined) return null;
  const title = basename(toSlashPath(file.path));
  return (
    <>
      <DeviceChip name={name} />
      <FileIcon kind="file" name={title} size="sm" tone="muted" className="shrink-0" />
      <span className="min-w-0 truncate">{title}</span>
    </>
  );
}

function RemoteFileTab({
  fileKey,
  active,
  onSelect,
  onRemove,
}: {
  fileKey: string;
  active: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const file = parseRemoteFileKey(fileKey);
  if (!file) return null;
  return (
    <PanelTab
      sessionKey={fileKey}
      active={active}
      title={file.path}
      file
      onSelect={onSelect}
      onRemove={onRemove}
    >
      <RemoteFileTabFace fileKey={fileKey} />
    </PanelTab>
  );
}

/** A panel's tab of another computer's session, hidden while another tab is in front. */
function RemotePaneHost({
  sessionKey,
  front,
  viewShown,
}: {
  sessionKey: string;
  front: boolean;
  viewShown: boolean;
}) {
  const target = useRemoteTarget(sessionKey);
  if (!target) return null;
  return (
    <div className={cn("absolute inset-0", !front && "hidden")} data-front={front || undefined}>
      <RemoteSessionPane target={target} visible={viewShown && front} />
    </div>
  );
}

/** Another computer's session's face, or null once this run of the app no longer knows it. */
function RemoteTabFace({ sessionKey, showDevice }: { sessionKey: string; showDevice: boolean }) {
  const target = useRemoteTarget(sessionKey);
  return target ? <RemoteTabLabel target={target} showDevice={showDevice} /> : null;
}

/** A tab of another computer's session, named with its computer and workspace. */
function RemoteTab({
  sessionKey: key,
  active,
  showDevice,
  onSelect,
  onRemove,
}: {
  sessionKey: string;
  active: boolean;
  /** Off when the panel shows the one computer of all its sessions. */
  showDevice: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const target = useRemoteTarget(key);
  if (!target) return null;
  return (
    <PanelTab
      sessionKey={key}
      active={active}
      title={`${target.title} · ${target.deviceName} · ${target.workspaceName}`}
      onSelect={onSelect}
      onRemove={onRemove}
    >
      <RemoteTabLabel target={target} showDevice={showDevice} />
    </PanelTab>
  );
}

/** A panel's tab: its face, dragged to another panel, closed with its button or a middle click. */
function PanelTab({
  sessionKey: key,
  active,
  title,
  file,
  onSelect,
  onRemove,
  children,
}: {
  sessionKey: string;
  active: boolean;
  title: string;
  file?: boolean;
  onSelect: () => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-agent-tab={key}
      className={cn(
        "group relative flex h-7 max-w-64 shrink-0 items-center rounded-(--radius-raised) text-app-ui-sm whitespace-nowrap transition-colors",
        active
          ? "bg-[var(--tab-active-bg)] text-foreground after:absolute after:right-2 after:bottom-0 after:left-2 after:h-0.5 after:rounded-full after:bg-[var(--state-selected-indicator)] after:content-['']"
          : "text-muted-foreground hover:bg-[var(--tab-hover-bg)] hover:text-foreground",
      )}
    >
      <button
        type="button"
        draggable
        aria-current={active || undefined}
        title={title}
        onClick={onSelect}
        onAuxClick={(e) => {
          if (e.button === 1) onRemove();
        }}
        onDragStart={(e) => {
          setAgentDrag(e.dataTransfer, key);
          beginDragInFlight();
        }}
        className="flex h-full min-w-0 items-center gap-1.5 rounded-(--radius-raised) pr-7 pl-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {children}
      </button>
      <IconButton
        label={t(file ? "agentView.pane.remove_file" : "agentView.pane.remove")}
        size="xs"
        onClick={onRemove}
        className={cn(
          "absolute right-1",
          active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
        )}
      >
        <X aria-hidden className="size-3" />
      </IconButton>
    </div>
  );
}

/** The words of the button that goes to an agent's tab, by its tab's type, as the agent list says them. */
function goToTabLabel(type: string | undefined): string {
  if (type === "editor") return "agentView.pane.show_file_tab";
  if (type === "claude") return "agentList.detail.show_claude_tab";
  if (type === "codex") return "agentList.detail.show_codex_tab";
  return "agentList.detail.show_terminal";
}

/** What an empty panel says: where its agents come from, and a way back to the list when it is hidden. */
function EmptyPane() {
  const { t } = useTranslation();
  const listHidden = useUIStore((s) => s.sidebarHidden);
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center gap-1 pt-12 select-none">
      <span className="text-app-ui-sm text-stone-gray">{t("agentView.pane.empty")}</span>
      <span className="text-app-ui-sm text-muted-foreground">{t("agentView.pane.empty_hint")}</span>
      {listHidden && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="pointer-events-auto mt-2 h-6 px-2.5 text-app-ui-sm"
          onClick={() => useUIStore.getState().setPanelHidden("sidebar", false)}
        >
          {t("agentView.pane.open_list")}
        </Button>
      )}
    </div>
  );
}

/**
 * In place of the agent of a remote workspace not connected: its tab is not
 * there to show until the workspace connects.
 */
function OfflinePane({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const workspace = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const online = useWorkspacesStore((s) => selectIsWorkspaceOnline(s, workspaceId));
  const status = useWorkspacesStore((s) => selectWorkspaceConnectionStatus(s, workspaceId));
  if (!workspace || workspace.location.kind === "local" || online) return null;
  const connecting = status === "connecting" || status === "reconnecting";
  const failed = status === "error" || status === "held-then-expired";
  const isWsl = workspace.location.kind === "wsl";
  const label =
    workspace.location.kind === "ssh"
      ? `${workspace.location.user ? `${workspace.location.user}@` : ""}${workspace.location.host}`
      : workspace.location.distro;
  const connect = () => retryWorkspaceConnection(workspaceId);
  return (
    <div className="absolute inset-0 flex island-surface">
      <EmptyState
        title={failed ? t("panel.connection_failed") : workspace.name}
        description={
          failed
            ? t(isWsl ? "panel.could_not_start_wsl" : "panel.could_not_connect", { label })
            : t(isWsl ? "panel.wsl_workspace" : "panel.ssh_workspace", { label })
        }
        actionLabel={
          connecting ? t("action.connecting") : failed ? t("action.retry") : t("action.connect")
        }
        onAction={connect}
        disabled={connecting}
        tone="status"
      />
    </div>
  );
}
