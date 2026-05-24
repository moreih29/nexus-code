import { Folder, GitBranch, Server, X } from "lucide-react";
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
  WORKSPACE_VISIBLE_STATUSES,
} from "../../state/stores/claude-status";
import { useGitStore } from "../../state/stores/git/index";
import { WorkspaceStatusGlyph } from "../sidebar/workspace-status-glyph";

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
// WorkspaceRow 컴포넌트 — hooks 사용을 위해 별도 컴포넌트로 분리
// ---------------------------------------------------------------------------

interface WorkspaceRowProps {
  ws: WorkspaceMeta;
  isActive: boolean;
  isDragSource: boolean;
  enabledLanguages: LspLanguageId[];
  rowDragProps: React.HTMLAttributes<HTMLElement>;
  connectionStatus: WorkspaceConnectionStatus;
  onSelectWorkspace: (id: string) => void;
  onTogglePin: (ws: WorkspaceMeta) => void;
  onRemoveWorkspace: (id: string) => void;
}

/**
 * 워크스페이스 사이드바 행 컴포넌트.
 *
 * 4~5줄 그리드 카드 구조 (SSH는 사이에 user@host 한 줄이 추가됨):
 * 1줄: [Icon 16] ws.name
 * (SSH 전용) user@host
 * 2줄: path (+ LSP 칩) — 로컬: rootPath의 마지막 2 세그먼트, SSH: remotePath의 마지막 2 세그먼트
 * 3줄: [GitBranch 아이콘] branch (있을 때만)
 * 4줄: [Glyph] message preview (둘 다 없으면 미렌더, 50자 컷)
 *
 * SSH 카드는 로컬 카드와 동일한 정보 구조를 따르되, user@host가 워크스페이스
 * 이름 바로 아래 한 줄로 추가된다. primary는 ws.name으로 통일한다(로컬과 동일).
 */
function WorkspaceRow({
  ws,
  isActive,
  isDragSource,
  enabledLanguages,
  rowDragProps,
  connectionStatus,
  onSelectWorkspace,
  onTogglePin,
  onRemoveWorkspace,
}: WorkspaceRowProps) {
  const isSsh = ws.location.kind === "ssh";
  const Icon = isSsh ? Server : Folder;

  // primary는 로컬/SSH 모두 ws.name으로 통일한다. SSH 카드는 별도의 user@host
  // 라인이 워크스페이스 이름 바로 아래에 추가된다. tooltip은 정보량이 많은
  // 쪽이 풀 컨텍스트(SSH 연결 정보 + 원격 경로, 로컬은 절대 경로).
  const sshLocation = ws.location.kind === "ssh" ? ws.location : null;
  const primaryText = ws.name;
  const secondaryTitle = sshLocation
    ? formatSshTooltip({
        user: sshLocation.user,
        host: sshLocation.host,
        port: sshLocation.port,
        remotePath: sshLocation.remotePath,
      })
    : ws.rootPath;
  // SSH 카드 이름 아래에 노출되는 한 줄(user@host). 로컬은 null.
  const sshUserHostLine = sshLocation
    ? formatSshSecondaryLine({
        user: sshLocation.user,
        host: sshLocation.host,
      })
    : null;

  // Claude 세션 집계 상태 구독 — wsTabs slice만 구독해 thrashing 방지.
  const wsTabs = useClaudeStatusStore((s) => s.byWorkspace[ws.id]);
  const aggregate = useMemo(() => {
    if (wsTabs === undefined) return null;
    return selectWorkspaceAggregateStatus(
      { byWorkspace: { [ws.id]: wsTabs } } as Parameters<typeof selectWorkspaceAggregateStatus>[0],
      ws.id,
    );
  }, [wsTabs, ws.id]);

  // 글리프에 표시할 상태 — WORKSPACE_VISIBLE_STATUSES에 포함된 경우에만 표시.
  // wsTabs가 undefined(StatusEntry가 한 번도 없었던 워크스페이스)이면 aggregate가 null이라
  // 글리프가 렌더되지 않는다. 한 번이라도 세션을 시작한 워크스페이스만 글리프가 노출된다.
  const glyphStatus =
    aggregate && WORKSPACE_VISIBLE_STATUSES.includes(aggregate.status)
      ? aggregate.status
      : null;

  // 카드 4번째 줄에 표시할 메시지 — 가장 최신 StatusEntry의 message 첫 줄을
  // 50자로 컷한다. 멀티라인 마크다운/코드블록이 와도 첫 줄만, 50자 초과 시
  // 말줄임 기호를 붙인다. 여러 탭이 있을 경우 가장 마지막에 변경된 entry의
  // message를 사용한다.
  const previewMessage = useMemo(() => {
    if (!wsTabs) return null;
    const entries = Object.values(wsTabs);
    const withMessage = entries
      .filter((e) => e.message !== undefined && e.message !== "")
      .sort((a, b) => b.since - a.since);
    if (withMessage.length === 0) return null;
    const raw = withMessage[0].message;
    if (raw === undefined) return null;
    const firstLine = raw.split("\n")[0].trim();
    return firstLine.length > 50 ? `${firstLine.slice(0, 50)}…` : firstLine;
  }, [wsTabs]);

  // git 세션에서 현재 브랜치 이름을 가져온다.
  const branchName = useGitStore((s) => {
    const session = s.sessions.get(ws.id);
    return session?.branchInfo?.current ?? session?.status?.branch?.current ?? null;
  });

  // 경로 한 줄 — 로컬/SSH 모두 마지막 2 세그먼트만 표시(로컬과 SSH 모두
  // secondaryWorkspaceText가 처리).
  const pathLine = useMemo(() => secondaryWorkspaceText(ws), [ws]);

  // permissionPending/error 상태이면 카드 좌측에 2px 색 border-l 표시.
  // 활성 카드의 --state-selected-indicator border-l과 배타적으로 처리한다.
  const attentionBorderClass =
    !isActive && glyphStatus === "permissionPending"
      ? "border-l-[var(--state-warning-fg)]"
      : !isActive && glyphStatus === "error"
        ? "border-l-[var(--state-error-fg)]"
        : null;

  // needsInput 상태이면 1줄 name을 font-semibold로 강조한다.
  const nameEmphasis = glyphStatus === "needsInput";

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
          {...(rowDragProps as React.HTMLAttributes<HTMLDivElement>)}
        >
          <button
            type="button"
            aria-current={isActive ? "page" : undefined}
            onClick={() => onSelectWorkspace(ws.id)}
            className={cn(
              // base layout — left accent bar 예약(border-l-2 transparent)으로 폭 안정.
              "block w-full px-3 py-2.5 rounded-(--radius-control) border-l-2 border-l-transparent",
              // reserve right space for absolute overlay buttons (Pin + X)
              "pr-10",
              // text + interaction
              "text-left cursor-pointer select-none font-sans transition-colors",
              "text-foreground",
              // 선택 상태: sidebar.item.selected.bg + state.selected.indicator 2px 좌측 accent.
              isActive
                ? "bg-[var(--sidebar-item-selected-bg)] border-l-[var(--state-selected-indicator)]"
                : cn(
                    // 비활성: transparent bg + hover
                    "bg-transparent hover:bg-[var(--state-hover-bg)]",
                    // attention 상태 좌측 2px border (활성과 배타)
                    attentionBorderClass,
                  ),
            )}
          >
            {/*
              2열 그리드:
              - col 1: 16px (ssh/local 아이콘만 — 글리프는 메시지 줄로 이동)
              - col 2: 가변 폭 텍스트(이름 / path / branch / glyph+message)

              글리프는 더 이상 좌측 컬럼에 세로 배치하지 않는다 — 메시지와 의미적으로
              한 줄에 묶이므로 4번째 줄 인라인으로 옮긴다.
            */}
            <span className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-2">
              {/* col 1: ssh/local 아이콘 + (SSH일 때) 연결 상태 인디케이터 */}
              <span className="flex flex-col items-center gap-1 mt-0.5">
                <Icon
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                {isSsh && <ConnectionStatusDot status={connectionStatus} />}
              </span>

              {/* 텍스트 영역 — 1~4줄 가변 높이 */}
              <span className="min-w-0">
                {/* 1줄: workspace 이름 */}
                <span
                  className={cn(
                    "block text-app-body-emphasis truncate min-w-0",
                    isActive ? "text-foreground" : "text-muted-foreground",
                    nameEmphasis && "font-semibold",
                  )}
                >
                  {primaryText}
                </span>

                {/* SSH 전용: user@host 한 줄(이름 바로 아래). 로컬에서는 미렌더. */}
                {sshUserHostLine && (
                  <span
                    className={cn(
                      "block text-app-micro mt-0.5 line-clamp-1 truncate",
                      isActive ? "text-foreground/70" : "text-muted-foreground/70",
                    )}
                  >
                    {sshUserHostLine}
                  </span>
                )}

                {/* 2줄: path (+ LSP 언어 칩) */}
                <span
                  className={cn(
                    "block text-app-micro mt-0.5 line-clamp-1 truncate",
                    isActive ? "text-foreground/70" : "text-muted-foreground/70",
                  )}
                  title={secondaryTitle}
                >
                  {pathLine}
                  {/* LSP 언어 칩 — path 줄 끝 우측 인라인, 상시 노출 */}
                  {LSP_FEATURE_ENABLED &&
                    CHIP_LANGUAGES.map((lang) => (
                      <LspLanguageChip
                        key={lang}
                        workspaceId={ws.id}
                        languageId={lang}
                        enabled={enabledLanguages.includes(lang)}
                      />
                    ))}
                </span>

                {/* 3줄: branch — 있을 때만. GitBranch 아이콘으로 시각적 affordance. */}
                {branchName && (
                  <span
                    className={cn(
                      "flex items-center gap-1 mt-0.5 text-app-micro min-w-0",
                      isActive ? "text-foreground/70" : "text-muted-foreground/70",
                    )}
                  >
                    <GitBranch
                      width={10}
                      height={10}
                      strokeWidth={1.5}
                      aria-hidden="true"
                      className="shrink-0"
                    />
                    <span className="truncate">{branchName}</span>
                  </span>
                )}

                {/* 4줄: glyph + message — 둘 중 하나라도 있을 때만 */}
                {(glyphStatus || previewMessage) && (
                  <span
                    className={cn(
                      "flex items-center gap-1.5 mt-1 text-app-ui-sm min-w-0",
                      isActive ? "text-foreground/70" : "text-muted-foreground",
                    )}
                  >
                    {glyphStatus && <WorkspaceStatusGlyph status={glyphStatus} />}
                    {previewMessage && (
                      <span className="truncate">{previewMessage}</span>
                    )}
                  </span>
                )}
              </span>

            </span>
          </button>

          {/* Pin toggle — absolute right-9, hover 시 노출. */}
          <PinToggle
            pinned={ws.pinned}
            workspaceName={ws.name}
            onToggle={() => onTogglePin(ws)}
            draggable={false}
          />

          {/* Remove button — hover 시 fade-in. */}
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
              onSelect: () => onTogglePin(ws),
            },
          ]}
        />
      </ContextMenuContent>
    </ContextMenuRoot>
  );
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
                <WorkspaceRow
                  ws={ws}
                  isActive={ws.id === activeWorkspaceId}
                  isDragSource={dragSourceId === ws.id}
                  enabledLanguages={lspByWorkspace[ws.id] ?? []}
                  rowDragProps={getRowDragSourceProps(ws.id, ws.pinned)}
                  connectionStatus={
                    ws.location.kind === "ssh"
                      ? (connectionStatusByWorkspaceId[ws.id] ?? "idle")
                      : "idle"
                  }
                  onSelectWorkspace={onSelectWorkspace}
                  onTogglePin={togglePin}
                  onRemoveWorkspace={onRemoveWorkspace}
                />
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
                <WorkspaceRow
                  ws={ws}
                  isActive={ws.id === activeWorkspaceId}
                  isDragSource={dragSourceId === ws.id}
                  enabledLanguages={lspByWorkspace[ws.id] ?? []}
                  rowDragProps={getRowDragSourceProps(ws.id, ws.pinned)}
                  connectionStatus={
                    ws.location.kind === "ssh"
                      ? (connectionStatusByWorkspaceId[ws.id] ?? "idle")
                      : "idle"
                  }
                  onSelectWorkspace={onSelectWorkspace}
                  onTogglePin={togglePin}
                  onRemoveWorkspace={onRemoveWorkspace}
                />
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
// Connection status dot
// ---------------------------------------------------------------------------

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
        // SSH 아이콘 바로 아래 인라인 배치. ring-background로 hover/active
        // 배경색과의 대비를 유지한다.
        "size-2 rounded-full ring-1 ring-background",
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
 * 카드의 경로 한 줄을 만든다. 로컬/SSH 모두 동일한 규칙: 절대경로의 마지막 두
 * 세그먼트만 노출(breadcrumb context). SSH의 user@host는 카드 상단 별도 줄로
 * 분리되었으므로 여기서는 처리하지 않는다.
 */
function secondaryWorkspaceText(workspace: WorkspaceMeta): string {
  const path =
    workspace.location.kind === "ssh"
      ? workspace.location.remotePath
      : workspace.rootPath;
  return path.split("/").filter(Boolean).slice(-2).join("/");
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
