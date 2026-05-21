import { CircleAlert, CircleDot, Folder, Server, TriangleAlert, X } from "lucide-react";
import React, { useMemo } from "react";
import { LSP_FEATURE_ENABLED } from "../../../shared/lsp/feature-flag";
import { Tooltip as RadixTooltip } from "radix-ui";
import { cn } from "@/utils/cn";
import type { LspLanguageId } from "../../../shared/types/app-state";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { UI_TOOLTIP_DELAY_MS } from "../../../shared/util/timing-constants";
import { useLspEnabledStore } from "../../state/stores/lsp-enabled";
import { useUIStore } from "../../state/stores/ui";
import type { WorkspaceConnectionStatus } from "../../state/stores/workspaces";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import {
  ContextMenuContent,
  ContextMenuItems,
  ContextMenuRoot,
  ContextMenuTrigger,
} from "../ui/context-menu";
import {
  folderName,
  formatSshSecondaryLine,
  formatSshTooltip,
} from "../workspace/add-workspace/ssh-helpers";
import { LspLanguageChip } from "./lsp-language-chip";
import { PinToggle } from "./pin-toggle";
import { SidebarResizeHandle } from "./sidebar-resize-handle";
import { RowDropSlot } from "./dnd/row-drop-slot";
import {
  buildSlotsForGroup,
  type SlotInfo,
  useWorkspaceRowDnd,
} from "./dnd/use-workspace-row-dnd";
import { useIpcAction } from "../../hooks/use-ipc-action";
import { ipcCallResult } from "../../ipc/client";
import { surfaceError } from "../../services/error-surface/surface-error";
import { appErrorFailed } from "../../../shared/error/app-error";
import {
  selectWorkspaceAggregateStatus,
  useClaudeStatusStore,
} from "../../state/stores/claude-status";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Languages for which a chip is rendered in the workspace row. */
const CHIP_LANGUAGES: LspLanguageId[] = ["typescript", "python"];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SidebarProps {
  workspaces: WorkspaceMeta[];
  activeWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onAddWorkspace: () => void;
  onRemoveWorkspace: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Sidebar({
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace,
}: SidebarProps) {
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const connectionStatusByWorkspaceId = useWorkspacesStore((s) => s.connectionStatusByWorkspaceId);
  // Subscribe to enabled languages — re-renders chips on toggle.
  const lspByWorkspace = useLspEnabledStore((s) => s.byWorkspace);

  // Pin toggle action — shared hook instance; IPC call is fire-and-forget since
  // workspace.changed / workspace.reordered broadcasts update the store.
  const { run: runPinToggle } = useIpcAction<WorkspaceMeta>({
    onSuccess: () => {
      // Store is updated via broadcast listeners in the workspaces store —
      // no local state update needed here.
    },
  });

  /**
   * Flips the pinned state of a workspace by calling workspace.update.
   * Errors are surfaced as a toast so the sidebar row stays uncluttered.
   * The store is updated via the workspace.changed broadcast listener —
   * no local state mutation is needed here.
   */
  function togglePin(ws: WorkspaceMeta) {
    runPinToggle(async (signal) => {
      const result = await ipcCallResult("workspace", "update", { id: ws.id, pinned: !ws.pinned }, { signal });
      if (!result.ok) {
        const err = appErrorFailed(result.message);
        surfaceError(err, { surface: "auto" });
        throw err;
      }
      return result.value;
    });
  }

  // Reorder action — called by the DnD hook when the user commits a drop.
  // The store is updated via workspace.reordered / workspace.changed broadcasts.
  const { run: runReorder } = useIpcAction<WorkspaceMeta>({});

  /**
   * Calls workspace.reorder IPC with the resolved beforeId/afterId and
   * targetGroup. Cross-group drops automatically flip the pinned flag on
   * the server (manager.ts handles this).
   */
  function handleReorder(args: {
    id: string;
    beforeId?: string;
    afterId?: string;
    targetGroup: "pinned" | "unpinned";
  }) {
    runReorder(async (signal) => {
      const result = await ipcCallResult("workspace", "reorder", args, { signal });
      if (!result.ok) {
        const err = appErrorFailed(result.message);
        surfaceError(err, { surface: "auto" });
        throw err;
      }
      return result.value;
    });
  }

  // DnD hook — drag source / drop target state for the slot-based DnD model.
  // workspaces is passed so the hook can suppress no-op slots (those adjacent
  // to the source row in the same group).
  const {
    dragSourceId,
    activeSlotKey,
    getRowDragSourceProps,
    getSlotDropProps,
    isSlotSuppressed,
  } = useWorkspaceRowDnd({
    workspaces,
    onReorder: handleReorder,
  });

  const isDragging = dragSourceId !== null;

  // Split workspaces into pinned and unpinned groups; the server-returned order
  // within each group is already correct (sort_order / pinned_sort_order ASC).
  const { pinnedGroup, unpinnedGroup } = splitWorkspaceGroups(workspaces);
  const hasBothGroups = pinnedGroup.length > 0 && unpinnedGroup.length > 0;
  // Show section labels only when both groups are present AND the sidebar is wide enough.
  const showLabels = hasBothGroups && sidebarWidth >= 200;

  // Pre-compute slot lists once per render so renderWorkspaceRow can index in.
  const pinnedSlots = buildSlotsForGroup(pinnedGroup, "pinned");
  const unpinnedSlots = buildSlotsForGroup(unpinnedGroup, "unpinned");

  /**
   * Renders a slot if it's not suppressed for the current source. Returning
   * null keeps the DOM minimal when nothing should be drop-targetable.
   */
  function renderSlot(slot: SlotInfo) {
    if (isSlotSuppressed(slot)) return null;
    return (
      <RowDropSlot
        key={slot.key}
        slot={slot}
        active={activeSlotKey === slot.key}
        isDragging={isDragging}
        dropProps={getSlotDropProps(slot)}
      />
    );
  }

  /**
   * Renders a single workspace row with all overlay buttons (Pin, Remove),
   * the context menu, and drag-and-drop wiring.
   *
   * Tab order by DOM position: row button → PinToggle → Remove button.
   * Drag-and-drop: the outer div is the draggable handle. PinToggle and the
   * Remove button carry draggable={false} so pointer-down on them never
   * initiates a drag.
   */
  function renderWorkspaceRow(ws: WorkspaceMeta) {
    const isActive = ws.id === activeWorkspaceId;
    const isDragSource = dragSourceId === ws.id;

    const isSsh = ws.location.kind === "ssh";
    const Icon = isSsh ? Server : Folder;
    const connectionStatus: WorkspaceConnectionStatus = isSsh
      ? (connectionStatusByWorkspaceId[ws.id] ?? "idle")
      : "idle";

    // For SSH: primary = remote folder leaf, secondary = user@host,
    // title = full connection + path for tooltip.
    // For local: primary = ws.name, secondary = parent/folder, title = full path.
    const sshLocation = ws.location.kind === "ssh" ? ws.location : null;
    const primaryText = sshLocation ? folderName(sshLocation.remotePath) : ws.name;
    const secondaryText = secondaryWorkspaceText(ws);
    const secondaryTitle = sshLocation
      ? formatSshTooltip({
          user: sshLocation.user,
          host: sshLocation.host,
          port: sshLocation.port,
          remotePath: sshLocation.remotePath,
        })
      : ws.rootPath;

    const enabledLanguages = lspByWorkspace[ws.id] ?? [];
    const rowDragProps = getRowDragSourceProps(ws.id, ws.pinned);

    return (
      <ContextMenuRoot key={ws.id}>
        <ContextMenuTrigger>
          {/*
            The outer div is the drag handle for the entire row.
            `cursor-grab` signals draggability at rest; `cursor-grabbing`
            overrides it while this row is being dragged.
            PinToggle and Remove button carry draggable={false} so clicking
            them never accidentally starts a drag.
          */}
          <div
            className={cn(
              "relative group mx-2",
              "cursor-grab",
              isDragSource && "cursor-grabbing opacity-40",
            )}
            {...rowDragProps}
          >
            <button
              type="button"
              aria-current={isActive ? "page" : undefined}
              onClick={() => onSelectWorkspace(ws.id)}
              className={cn(
                // base layout — left accent bar reserved (border-l-2 transparent) so width is stable across states
                "block w-full px-4 py-2 rounded-(--radius-control) border-l-2 border-l-transparent",
                // reserve right space so all overlay buttons (LSP chips + Pin + X) don't overlap text
                "pr-16",
                // text + interaction
                "text-left cursor-pointer select-none font-sans transition-colors",
                "text-foreground",
                // selected state: sidebar.item.selected.bg bg + state.selected.indicator 2px left accent
                // Shared single-language token with tab selection (plan #48 C-1, design.md §7).
                isActive
                  ? "bg-[var(--sidebar-item-selected-bg)] border-l-[var(--state-selected-indicator)]"
                  : // rest/hover state: transparent bg + state.hover.bg on hover (light-theme safe, design.md §7)
                    "bg-transparent hover:bg-[var(--state-hover-bg)]",
              )}
            >
              <span className="grid grid-cols-[16px_minmax(0,1fr)] items-center gap-2">
                <Icon
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  {/* Workspace name — 14px body, truncate for long names */}
                  <span
                    className={cn(
                      "block text-app-body-emphasis truncate min-w-0",
                      isActive ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {primaryText}
                  </span>
                  {/* Location hint — micro: 11px, truncate */}
                  <span
                    className="block text-app-micro text-muted-foreground mt-0.5 truncate min-w-0"
                    title={secondaryTitle}
                  >
                    {secondaryText}
                  </span>
                </span>
              </span>
            </button>

            {isSsh && <ConnectionStatusDot status={connectionStatus} />}

            {/* Claude 집계 인디케이터 — 워크스페이스 행 오른쪽 끝 attention 글리프.
                SSH dot(아이콘 우하단 원형 채움)과 위치/형태가 명확히 분리됨. */}
            <ClaudeWorkspaceIndicator workspaceId={ws.id} />

            {/* LSP language chips — shifted to right-14 to leave room for the pin slot.
                draggable={false} prevents drag initiation when clicking the chip. */}
            {LSP_FEATURE_ENABLED && (
              <div
                className="absolute top-1/2 -translate-y-1/2 right-14 flex items-center gap-0.5"
                draggable={false}
              >
                {CHIP_LANGUAGES.map((lang) => (
                  <LspLanguageChip
                    key={lang}
                    workspaceId={ws.id}
                    languageId={lang}
                    enabled={enabledLanguages.includes(lang)}
                  />
                ))}
              </div>
            )}

            {/* Pin toggle — right-9, between LSP chips and remove button.
                Tab order: row button → PinToggle → Remove (DOM order).
                draggable={false} prevents drag initiation from this button. */}
            <PinToggle
              pinned={ws.pinned}
              workspaceName={ws.name}
              onToggle={() => togglePin(ws)}
              draggable={false}
            />

            {/* Remove button — appears on hover.
                draggable={false} prevents drag initiation from this button. */}
            <button
              type="button"
              draggable={false}
              onClick={(e) => {
                e.stopPropagation();
                onRemoveWorkspace(ws.id);
              }}
              aria-label={`Remove workspace ${ws.name}`}
              className={cn(
                "absolute top-1/2 -translate-y-1/2 right-2 inline-flex items-center justify-center",
                "size-5 rounded-(--radius-control)",
                "text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground",
                "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity",
              )}
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItems
            items={[
              {
                kind: "item",
                label: ws.pinned ? "Unpin" : "Pin to top",
                onSelect: () => togglePin(ws),
              },
            ]}
          />
        </ContextMenuContent>
      </ContextMenuRoot>
    );
  }

  return (
    // Islands model (design.md §2): <aside> is a transparent positioning shell;
    // island surface lives on the inner wrapper so overflow-hidden clips content
    // without clipping the absolute-positioned <SidebarResizeHandle>.
    <aside className="relative shrink-0 flex flex-col" style={{ width: sidebarWidth }}>
      <div className="relative flex flex-col flex-1 min-h-0 island-surface rounded-(--radius-island) overflow-hidden">
        {/* Empty state — centered against the full island (matches files panel
            and welcome screen); pointer-events-none keeps the bottom Add button
            clickable underneath the inset-0 overlay. */}
        {workspaces.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-app-ui-sm text-muted-foreground pointer-events-none">
            <div>
              No workspaces yet.
              <br />
              Add one to get started.
            </div>
          </div>
        )}
        <RadixTooltip.Provider delayDuration={UI_TOOLTIP_DELAY_MS}>
          <div className="py-3 flex-1 overflow-y-auto app-scrollbar">
            {/* Pinned group — rendered first; always float to the top of the list.
                For N rows, pinnedSlots has N+1 entries; the indices align as
                [slot 0, row 0, slot 1, row 1, ..., row N-1, slot N]. */}
            {showLabels && pinnedGroup.length > 0 && (
              <div className="text-app-micro text-muted-foreground tracking-wide uppercase px-4 py-1">
                Pinned
              </div>
            )}
            {pinnedGroup.length > 0 && renderSlot(pinnedSlots[0])}
            {pinnedGroup.map((ws, i) => (
              <React.Fragment key={ws.id}>
                {renderWorkspaceRow(ws)}
                {renderSlot(pinnedSlots[i + 1])}
              </React.Fragment>
            ))}

            {/* Gap + optional "Recent" label between groups — only when both are non-empty. */}
            {hasBothGroups && (
              <div className={cn("mt-2", showLabels && "text-app-micro text-muted-foreground tracking-wide uppercase px-4 py-1")}>
                {showLabels ? "Recent" : null}
              </div>
            )}

            {unpinnedGroup.length > 0 && renderSlot(unpinnedSlots[0])}
            {unpinnedGroup.map((ws, i) => (
              <React.Fragment key={ws.id}>
                {renderWorkspaceRow(ws)}
                {renderSlot(unpinnedSlots[i + 1])}
              </React.Fragment>
            ))}
          </div>
        </RadixTooltip.Provider>

        <div className="py-2">
          <button
            type="button"
            onClick={onAddWorkspace}
            className={cn(
              "block w-[calc(100%-16px)] mx-2 px-4 py-2 rounded-(--radius-control)",
              "text-left cursor-pointer select-none font-sans transition-colors",
              "text-app-body text-muted-foreground bg-transparent",
              "hover:bg-[var(--state-hover-bg)] hover:text-foreground",
            )}
            aria-label="Add workspace"
          >
            <span className="inline-flex items-center gap-2">
              <span aria-hidden="true">+</span>
              <span>Add workspace</span>
            </span>
          </button>
        </div>
      </div>
      <SidebarResizeHandle />
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Claude 워크스페이스 집계 인디케이터
// ---------------------------------------------------------------------------

/**
 * 워크스페이스 행 오른쪽 끝에 Claude 세션 집계 상태를 표시한다.
 *
 * 표시 조건: needsInput | permissionPending | error 탭이 하나 이상 있을 때.
 * running-only 워크스페이스는 표시하지 않는다(사이드바 혼잡 방지).
 * 우선순위: permissionPending(4) > error(3) > needsInput(2).
 * 카운트 ≥ 2이면 글리프 옆에 appMicro(11px) 숫자를 표시한다.
 */
function ClaudeWorkspaceIndicator({ workspaceId }: { workspaceId: string }) {
  // workspaceId の tab record のみを購読し、selectWorkspaceAggregateStatus をメモ化する。
  // byWorkspace[workspaceId] が変わったときだけ再計算されるので LazyVStack thrashing を防ぐ。
  const wsTabs = useClaudeStatusStore((s) => s.byWorkspace[workspaceId]);
  const aggregate = useMemo(() => {
    if (wsTabs === undefined) return null;
    // selectWorkspaceAggregateStatus はストア全体を受け取るが、byWorkspace の
    // 当該 workspaceId スライスだけあれば十分なので最小限の形で渡す。
    return selectWorkspaceAggregateStatus(
      { byWorkspace: { [workspaceId]: wsTabs } } as Parameters<
        typeof selectWorkspaceAggregateStatus
      >[0],
      workspaceId,
    );
  }, [wsTabs, workspaceId]);

  // attention 필요 상태가 없으면(count === 0 또는 null) 렌더하지 않는다.
  if (!aggregate || aggregate.count === 0) return null;

  const { status, count } = aggregate;

  // 글리프/색 매핑 — tab-item.tsx와 동일한 token 규칙.
  let glyph: React.ReactNode;
  if (status === "permissionPending") {
    glyph = (
      <CircleAlert
        width={12}
        height={12}
        strokeWidth={1.5}
        className="shrink-0 text-(--state-warning-fg)"
      />
    );
  } else if (status === "error") {
    glyph = (
      <TriangleAlert
        width={12}
        height={12}
        strokeWidth={1.5}
        className="shrink-0 text-(--state-error-fg)"
      />
    );
  } else {
    // needsInput
    glyph = (
      <CircleDot
        width={12}
        height={12}
        strokeWidth={1.5}
        className="shrink-0 text-(--tab-claude-attention-fg)"
      />
    );
  }

  const countLabel = count >= 2 ? count : undefined;
  const ariaLabel = `${count} Claude session${count === 1 ? "" : "s"} need attention`;

  return (
    <span
      role="status"
      aria-label={ariaLabel}
      title={ariaLabel}
      className="absolute top-1/2 -translate-y-1/2 right-20 flex items-center gap-1 pointer-events-none"
    >
      {glyph}
      {countLabel !== undefined && (
        <span aria-hidden className="text-app-micro text-muted-foreground">
          {countLabel}
        </span>
      )}
    </span>
  );
}

/**
 * Renders the compact SSH connection indicator with text for assistive tech.
 */
function ConnectionStatusDot({ status }: { status: WorkspaceConnectionStatus }) {
  const label = `SSH workspace, ${status}`;
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className={cn(
        "absolute bottom-2 right-2 size-2 rounded-full ring-1 ring-background",
        connectionStatusClassName(status),
      )}
    />
  );
}

/**
 * Maps sidebar display statuses to measured OKLCH token colors.
 */
function connectionStatusClassName(status: WorkspaceConnectionStatus): string {
  switch (status) {
    case "connected":
      return "bg-[var(--color-workspace-connection-connected)]";
    case "connecting":
    case "reconnecting":
      return "bg-[var(--color-workspace-connection-connecting)]";
    case "error":
      return "bg-[var(--color-workspace-connection-error)]";
    case "idle":
      return "bg-[var(--color-workspace-connection-idle)]";
  }
}

/**
 * Chooses the compact secondary line for local and SSH workspace rows.
 * SSH: always `user@host` (configAlias is dropped in favour of connection info visibility).
 * Local: last two path segments for breadcrumb context.
 */
function secondaryWorkspaceText(workspace: WorkspaceMeta): string {
  if (workspace.location.kind === "ssh") {
    return formatSshSecondaryLine({
      user: workspace.location.user,
      host: workspace.location.host,
    });
  }

  return workspace.rootPath.split("/").filter(Boolean).slice(-2).join("/");
}

// ---------------------------------------------------------------------------
// Group split — pure, exported for unit tests
// ---------------------------------------------------------------------------

/**
 * Splits a flat workspace list into pinned and unpinned groups.
 *
 * The caller's list is assumed to arrive in display order (pinned first,
 * then unpinned, both groups sorted by their respective sort columns).
 * This function only partitions — it does not re-sort.
 */
export function splitWorkspaceGroups(workspaces: WorkspaceMeta[]): {
  pinnedGroup: WorkspaceMeta[];
  unpinnedGroup: WorkspaceMeta[];
} {
  return {
    pinnedGroup: workspaces.filter((w) => w.pinned),
    unpinnedGroup: workspaces.filter((w) => !w.pinned),
  };
}
