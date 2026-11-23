import i18next from "i18next";
import { Columns2, Rows2, SquareArrowOutUpRight, X } from "lucide-react";
import { Tabs as RadixTabs } from "radix-ui";
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
import { remoteTitle } from "@/services/remote/display-name";
import { useAgentViewStore } from "@/state/stores/agent-view";
import { useRemoteTarget, useRemoteViewStore } from "@/state/stores/remote-view";
import { type EditorTab, useTabsStore } from "@/state/stores/tabs";
import { useUIStore } from "@/state/stores/ui";
import { rootWorkspaceId, useWorkspace, useWorkspacesStore } from "@/state/stores/workspaces";
import { copyTextViaIpc } from "@/utils/clipboard";
import { cn } from "@/utils/cn";
import { beginDragInFlight } from "@/utils/drag-in-flight";
import { listenForPaneActivation } from "@/utils/pane-activation";
import { basename } from "@/utils/path";
import { toSlashPath } from "../../../shared/fs/drive-path";
import { isRemoteFileKey, parseRemoteFileKey } from "../../../shared/fs/remote-file-key";
import { COMMANDS } from "../../../shared/keybindings/commands";
import type { DropZone } from "../../types/workbench-dnd";
import { StateGlyph, stateLabel } from "../agent-list/session-status";
import { AgentMark } from "../agent-list/status-view";
import { FileIcon } from "../files/file-tree/file-icon";
import { Button } from "../ui/button";
import type { MenuItemSpec } from "../ui/context-menu";
import { IconButton } from "../ui/icon-button";
import { AGENT_VIEW_SLOTS, slotRegistry } from "../workspace/content/slot-registry";
import { DropIndicator } from "../workspace/dnd/drop-indicator";
import { zoneFromCoords } from "../workspace/dnd/use-drop-target";
import { OfflineWorkspace, useWorkspaceOffline } from "../workspace/offline-workspace";
import { OverflowTabsMenu } from "../workspace/tabs/overflow-tabs-menu";
import { TabIcon, TabItem, useTabDirty } from "../workspace/tabs/tab-item";
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

  const [outerEl, setOuterEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!outerEl) return;
    return listenForPaneActivation(outerEl, () =>
      update((layout) => setActiveLeaf(layout, leaf.id)),
    );
  }, [outerEl, leaf.id]);

  const [dropZone, setDropZone] = useState<DropZone | null>(null);
  const [insertion, setInsertion] = useState<TabInsertion | null>(null);
  useEffect(() => {
    if (!outerEl) return;
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
  const removeAll = (keys: readonly string[]) =>
    update((layout) => keys.reduce((next, key) => removeKey(next, key), layout));
  const splitTo = (direction: "right" | "down") =>
    update((layout) => splitLeaf(layout, leaf.id, direction));

  const workspaceIds = new Set(leaf.tabIds.map((key) => parseSessionKey(key)?.workspaceId));
  const [onlyWorkspace] = workspaceIds;
  const sharedWorkspace = workspaceIds.size === 1 ? onlyWorkspace : undefined;
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
        <RadixTabs.Root
          value={leaf.activeTabId ?? ""}
          onValueChange={(key) => update((layout) => selectKey(layout, leaf.id, key))}
          className="flex h-full min-w-0 flex-1 items-center"
        >
          <div
            ref={stripRef}
            className="relative h-full min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            style={{ maskImage: fadeMask(overflow) }}
          >
            <RadixTabs.List
              aria-label={t("tabBar.open_tabs")}
              className="flex h-full w-max items-center gap-0.5"
            >
              {leaf.tabIds.map((key, index) => {
                const menu = panelTabMenu(leaf.tabIds, index, removeAll);
                return isRemoteKey(key) ? (
                  <RemoteTab
                    key={key}
                    sessionKey={key}
                    showDevice={sharedDevice === undefined}
                    menu={menu}
                    onRemove={() => remove(key)}
                  />
                ) : isRemoteFileKey(key) ? (
                  <RemoteFileTab key={key} fileKey={key} menu={menu} onRemove={() => remove(key)} />
                ) : (
                  <AgentTab
                    key={key}
                    sessionKey={key}
                    agents={agents}
                    showWorkspace={sharedWorkspace === undefined}
                    menu={menu}
                    onRemove={() => remove(key)}
                  />
                );
              })}
            </RadixTabs.List>
            {insertion && (
              <div
                aria-hidden
                className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-primary"
                style={{ left: insertion.x, transform: "translateX(-1px)" }}
              />
            )}
          </div>
        </RadixTabs.Root>
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

      <div ref={slotRef} data-agent-slot={leaf.id} className="relative min-h-0 min-w-0 flex-1">
        {leaf.tabIds.length === 0 && <EmptyPane />}
        {front && <OfflinePane workspaceId={front.workspaceId} />}
        {viewShown && frontFile && <RemoteFilePane key={leaf.activeTabId} file={frontFile} />}
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

      {lit && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-20 rounded-(--radius-island) border-2 border-dashed border-[var(--state-selected-indicator)]"
        />
      )}
      {split && !isActive && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[var(--surface-island-inactive-veil)]"
        />
      )}
    </div>
  );
});

function WorkspaceChip({ workspaceId, className }: { workspaceId: string; className?: string }) {
  const name = useWorkspace(workspaceId, (w) => w?.name);
  const rootId = useWorkspacesStore((s) => rootWorkspaceId(s.workspaces, workspaceId));
  const color = useWorkspace(rootId, (w) => w?.color);
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

function useLocalTabInfo(key: string, agents: Agents) {
  const ref = parseSessionKey(key);
  const tab = useTabsStore((s) => (ref ? s.byWorkspace[ref.workspaceId]?.[ref.tabId] : undefined));
  const workspaceName = useWorkspace(ref?.workspaceId, (w) => w?.name);
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
  showWorkspace,
  menu,
  onRemove,
}: {
  sessionKey: string;
  agents: Agents;
  showWorkspace: boolean;
  menu: PanelTabMenu;
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
      title={title}
      file={info.kind === "file"}
      menu={menu}
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
  menu,
  onRemove,
}: {
  fileKey: string;
  menu: PanelTabMenu;
  onRemove: () => void;
}) {
  const file = parseRemoteFileKey(fileKey);
  if (!file) return null;
  return (
    <PanelTab sessionKey={fileKey} title={file.path} file menu={menu} onRemove={onRemove}>
      <RemoteFileTabFace fileKey={fileKey} />
    </PanelTab>
  );
}

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

function RemoteTabFace({ sessionKey, showDevice }: { sessionKey: string; showDevice: boolean }) {
  const target = useRemoteTarget(sessionKey);
  return target ? <RemoteTabLabel target={target} showDevice={showDevice} /> : null;
}

function RemoteTab({
  sessionKey: key,
  showDevice,
  menu,
  onRemove,
}: {
  sessionKey: string;
  showDevice: boolean;
  menu: PanelTabMenu;
  onRemove: () => void;
}) {
  const target = useRemoteTarget(key);
  if (!target) return null;
  return (
    <PanelTab
      sessionKey={key}
      title={`${remoteTitle(target.title)} · ${target.deviceName} · ${target.workspaceName}`}
      menu={menu}
      onRemove={onRemove}
    >
      <RemoteTabLabel target={target} showDevice={showDevice} />
    </PanelTab>
  );
}

function PanelTab({
  sessionKey: key,
  title,
  file,
  menu,
  onRemove,
  children,
}: {
  sessionKey: string;
  title: string;
  file?: boolean;
  menu: PanelTabMenu;
  onRemove: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <TabItem
      readOnly
      value={key}
      label={title}
      title={title}
      face={<span className="flex min-w-0 max-w-64 items-center gap-1.5">{children}</span>}
      closeLabel={t(file ? "agentView.pane.remove_file" : "agentView.pane.remove")}
      menu={menu(file ? title : undefined)}
      tabAttrs={{ "data-agent-tab": key }}
      onDragStart={(dataTransfer) => {
        setAgentDrag(dataTransfer, key);
        beginDragInFlight();
      }}
      onActivate={() => focusPanelTab(key)}
      onClose={onRemove}
    />
  );
}

type PanelTabMenu = (path?: string) => MenuItemSpec[];

export function panelTabMenu(
  keys: readonly string[],
  index: number,
  remove: (keys: readonly string[]) => void,
): PanelTabMenu {
  const t = i18next.t.bind(i18next);
  const key = keys[index];
  return (path) => [
    {
      kind: "item",
      label: t(path !== undefined ? "agentView.pane.remove_file" : "agentView.pane.remove"),
      onSelect: () => remove([key]),
    },
    {
      kind: "item",
      label: t("agentView.pane.remove_others"),
      onSelect: () => remove(keys.filter((each) => each !== key)),
    },
    {
      kind: "item",
      label: t("agentView.pane.remove_right"),
      onSelect: () => remove(keys.slice(index + 1)),
    },
    { kind: "item", label: t("agentView.pane.remove_all"), onSelect: () => remove(keys) },
    ...(path !== undefined
      ? [
          { kind: "separator" as const },
          {
            kind: "item" as const,
            label: t("tabBar.copy_path"),
            onSelect: () => void copyTextViaIpc(path),
          },
        ]
      : []),
  ];
}

function goToTabLabel(type: string | undefined): string {
  if (type === "editor") return "agentView.pane.show_file_tab";
  if (type === "claude") return "agentList.detail.show_claude_tab";
  if (type === "codex") return "agentList.detail.show_codex_tab";
  return "agentList.detail.show_terminal";
}

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

function OfflinePane({ workspaceId }: { workspaceId: string }) {
  if (!useWorkspaceOffline(workspaceId)) return null;
  return (
    <div className="absolute inset-0 flex items-center justify-center island-surface">
      <OfflineWorkspace workspaceId={workspaceId} />
    </div>
  );
}
