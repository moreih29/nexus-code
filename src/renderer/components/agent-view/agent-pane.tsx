// One panel of the agent view: a tab bar of the agents it holds, from any
// workspace, and below it the one in front — the very tab its workspace
// shows, moved here. Taking an agent out of the panel leaves it running.

import { Columns2, FolderOpen, Rows2, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SplitLeaf } from "@/engine";
import { shortcutFor } from "@/keybindings/shortcut-labels";
import { type Agents, workspaceColor } from "@/services/agent-view/agents";
import {
  type AgentLayout,
  closeLeaf,
  parseSessionKey,
  placeKey,
  removeKey,
  selectKey,
  setActiveLeaf,
  splitLeaf,
} from "@/services/agent-view/layout";
import { openInWorkspace } from "@/services/sessions/actions";
import { requestTabFocus } from "@/services/tab-focus";
import { useAgentViewStore } from "@/state/stores/agent-view";
import { useTabsStore } from "@/state/stores/tabs";
import {
  rootWorkspaceId,
  selectIsWorkspaceOnline,
  selectWorkspaceConnectionStatus,
  useWorkspacesStore,
} from "@/state/stores/workspaces";
import { cn } from "@/utils/cn";
import { COMMANDS } from "../../../shared/keybindings/commands";
import { createLogger } from "../../../shared/log/renderer";
import { ipcCallResult } from "../../ipc/client";
import { StateGlyph, stateLabel } from "../sessions/session-status";
import { AgentMark } from "../sessions/status-view";
import { EmptyState } from "../ui/empty-state";
import { AGENT_VIEW_SLOTS, slotRegistry } from "../workspace/content/slot-registry";
import { DropIndicator } from "../workspace/dnd/drop-indicator";
import type { DropZone } from "../workspace/dnd/types";
import { zoneFromCoords } from "../workspace/dnd/use-drop-target";
import { agentDragKey, isAgentDrag, setAgentDrag, ZONE_DIRECTION } from "./drag";

const log = createLogger("agent-view");

function update(change: (layout: AgentLayout) => AgentLayout): void {
  useAgentViewStore.getState().update(change);
}

/** Puts the keyboard in the agent `key` names. */
function focusKey(key: string): void {
  const session = parseSessionKey(key);
  if (session) requestTabFocus(session.tabId);
}

export function AgentPane({ leaf, agents }: { leaf: SplitLeaf; agents: Agents }) {
  const { t } = useTranslation();
  const isActive = useAgentViewStore((s) => s.activeLeafId === leaf.id);
  const split = useAgentViewStore((s) => s.root.kind === "split");
  const lit = useAgentViewStore((s) => s.hoveredKey !== null && leaf.tabIds.includes(s.hoveredKey));
  const front = leaf.activeTabId !== null ? parseSessionKey(leaf.activeTabId) : null;

  const slotElRef = useRef<HTMLElement | null>(null);
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
  useEffect(() => {
    if (!outerEl) return;
    // Every element the drag passes enters and leaves; it left the panel
    // once the count is back to none.
    let depth = 0;
    const reset = () => {
      depth = 0;
      setDropZone(null);
    };
    const zoneOf = (e: DragEvent): DropZone => {
      const slot = slotElRef.current;
      return slot ? zoneFromCoords(slot.getBoundingClientRect(), e.clientX, e.clientY) : "center";
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
      const zone = zoneOf(e);
      setDropZone((prev) => (prev === zone ? prev : zone));
    };
    const onLeave = (e: DragEvent) => {
      if (!isAgentDrag(e.dataTransfer)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDropZone(null);
    };
    const onDrop = (e: DragEvent) => {
      if (!isAgentDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      const key = agentDragKey(e.dataTransfer);
      const zone = zoneOf(e);
      reset();
      if (key === null) return;
      // On a tab: in its place. On the tab bar: at the end.
      const onTab = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-agent-tab]");
      const at = onTab?.dataset.agentTab;
      const index = at !== undefined ? leaf.tabIds.indexOf(at) : -1;
      update((layout) =>
        placeKey(
          layout,
          key,
          leaf.id,
          zone === "center" ? undefined : ZONE_DIRECTION[zone],
          index >= 0 ? index : undefined,
        ),
      );
      focusKey(key);
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
    focusKey(key);
  };
  const remove = (key: string) => update((layout) => removeKey(layout, key));
  const splitTo = (direction: "right" | "down") =>
    update((layout) => splitLeaf(layout, leaf.id, direction));

  return (
    <div
      ref={setOuterEl}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-(--radius-island) island-surface"
      data-testid="agent-pane"
      data-leaf-id={leaf.id}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 px-1.5">
        <div className="flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {leaf.tabIds.map((key) => (
            <AgentTab
              key={key}
              sessionKey={key}
              agents={agents}
              active={key === leaf.activeTabId}
              onSelect={() => select(key)}
              onRemove={() => remove(key)}
            />
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {front && (
            <PaneTool label={t("agentView.pane.reveal")} onClick={() => openInWorkspace(front)}>
              <FolderOpen aria-hidden className="size-3.5" />
            </PaneTool>
          )}
          <PaneTool
            label={withShortcut(t("tabBar.split_right"), shortcutFor(COMMANDS.groupSplitRight))}
            onClick={() => splitTo("right")}
          >
            <Columns2 aria-hidden className="size-3.5" />
          </PaneTool>
          <PaneTool
            label={withShortcut(t("tabBar.split_down"), shortcutFor(COMMANDS.groupSplitDown))}
            onClick={() => splitTo("down")}
          >
            <Rows2 aria-hidden className="size-3.5" />
          </PaneTool>
          {(split || leaf.tabIds.length > 0) && (
            <PaneTool
              label={withShortcut(t("agentView.pane.close"), shortcutFor(COMMANDS.groupClose))}
              onClick={() => update((layout) => closeLeaf(layout, leaf.id))}
            >
              <X aria-hidden className="size-3.5" />
            </PaneTool>
          )}
        </div>
      </div>

      {/* Where the front agent's tab is moved in (see ContentHost). */}
      <div ref={slotRef} data-agent-slot={leaf.id} className="relative min-h-0 min-w-0 flex-1">
        {leaf.tabIds.length === 0 && <EmptyPane />}
        {front && <OfflinePane workspaceId={front.workspaceId} />}
        {dropZone && <DropIndicator zone={dropZone} />}
      </div>

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
}

function withShortcut(label: string, shortcut: string | null | undefined): string {
  return shortcut ? `${label} (${shortcut})` : label;
}

function PaneTool({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded-(--radius-control) text-muted-foreground transition-colors hover:bg-[var(--state-hover-bg)] hover:text-foreground"
    >
      {children}
    </button>
  );
}

function AgentTab({
  sessionKey: key,
  agents,
  active,
  onSelect,
  onRemove,
}: {
  sessionKey: string;
  agents: Agents;
  active: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const ref = parseSessionKey(key);
  const tab = useTabsStore((s) => (ref ? s.byWorkspace[ref.workspaceId]?.[ref.tabId] : undefined));
  const workspaceName = useWorkspacesStore((s) =>
    ref ? s.workspaces.find((w) => w.id === ref.workspaceId)?.name : undefined,
  );
  const rootId = useWorkspacesStore((s) =>
    ref ? rootWorkspaceId(s.workspaces, ref.workspaceId) : key,
  );
  if (!ref || !tab) return null;
  const session = agents.byKey.get(key)?.session;
  const title = session?.title ?? tab.title;
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
        title={workspaceName ? `${title} · ${workspaceName}` : title}
        onClick={onSelect}
        onAuxClick={(e) => {
          if (e.button === 1) onRemove();
        }}
        onDragStart={(e) => setAgentDrag(e.dataTransfer, key)}
        className="flex h-full min-w-0 items-center gap-1.5 rounded-(--radius-raised) pr-7 pl-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="flex max-w-24 shrink-0 items-center gap-1 rounded-full border border-border px-1.5 text-app-micro text-muted-foreground">
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full"
            style={{ background: workspaceColor(rootId) }}
          />
          <span className="truncate">{workspaceName}</span>
        </span>
        {session ? (
          <AgentMark session={session} />
        ) : (
          <AgentMark
            session={{
              key,
              workspaceId: ref.workspaceId,
              tabId: ref.tabId,
              title,
              kind: tab.type === "claude" || tab.type === "codex" ? tab.type : "terminal",
              agent: undefined,
              state: "idle",
              phase: "idle",
              estimated: false,
              since: undefined,
              message: undefined,
              prompt: undefined,
            }}
          />
        )}
        <span className="min-w-0 truncate">{title}</span>
        {session && session.phase !== "idle" && (
          <span role="img" aria-label={stateLabel(session)} className="inline-flex">
            <StateGlyph state={session.state} />
          </span>
        )}
      </button>
      <button
        type="button"
        aria-label={t("agentView.pane.remove")}
        title={t("agentView.pane.remove")}
        onClick={onRemove}
        className={cn(
          "absolute right-1 flex size-5 items-center justify-center rounded-(--radius-control) text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground",
          active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
        )}
      >
        <X aria-hidden className="size-3" />
      </button>
    </div>
  );
}

/** What an empty panel says: where its agents come from. */
function EmptyPane() {
  const { t } = useTranslation();
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center gap-1 pt-12 select-none">
      <span className="text-app-ui-sm text-stone-gray">{t("agentView.pane.empty")}</span>
      <span className="text-app-ui-sm text-muted-foreground">{t("agentView.pane.empty_hint")}</span>
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
  const connect = () => {
    void ipcCallResult("workspace", "activate", { id: workspaceId }).then((result) => {
      if (!result.ok) log.warn(`activate failed: ${result.message}`);
    });
  };
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
