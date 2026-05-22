import { CircleAlert, CircleCheck, CircleDot, Loader, Lock, TriangleAlert, X } from "lucide-react";
import { Tabs as RadixTabs, Tooltip as RadixTooltip } from "radix-ui";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { useDragSource } from "@/components/ui/use-drag-source";
import { DND_TAB_ITEM_ATTR } from "@/components/workspace/dnd/markers";
import { cacheUriFor } from "@/services/editor/model/cache";
import { isDirty, subscribeFileDirty } from "@/services/editor/model/dirty-tracker";
import { cn } from "@/utils/cn";
import type { ClaudeStatus } from "../../../../shared/claude/status";
import { selectStatusForTab, useClaudeStatusStore } from "../../../state/stores/claude-status";
import { type Tab, useTabsStore } from "../../../state/stores/tabs";
import { MIME_TAB, type TabDragPayload } from "../dnd/types";

function PinIcon() {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative pin icon, hidden via aria-hidden
    <svg
      aria-hidden
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17H19V16L17 10V5H18V3H6V5H7V10L5 16V17Z" />
    </svg>
  );
}

/**
 * Subscribe to dirty state for an editor tab. Returns false for
 * non-editor tabs and for tabs whose model has not yet been attached
 * (the tracker creates entries lazily on model load).
 */
function useTabDirty(tab: Tab): boolean {
  const cacheUri =
    tab.type === "editor"
      ? cacheUriFor(tab.props.workspaceId, tab.props.filePath)
      : null;
  const subscribe = useCallback(
    (cb: () => void) => (cacheUri ? subscribeFileDirty(cacheUri, cb) : () => {}),
    [cacheUri],
  );
  const getSnapshot = useCallback(() => (cacheUri ? isDirty(cacheUri) : false), [cacheUri]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/**
 * Claude 상태에 대응하는 aria-label 텍스트를 반환한다.
 * 스크린리더가 "Claude: waiting for permission" 등 명시적 레이블을 읽는다.
 */
function claudeAriaLabel(status: ClaudeStatus): string {
  switch (status) {
    case "running":
      return "Claude: running";
    case "completed":
      return "Claude: response complete";
    case "needsInput":
      return "Claude: waiting for input";
    case "permissionPending":
      return "Claude: waiting for permission";
    case "error":
      return "Claude: error";
    case "idle":
      return "Claude: idle";
  }
}

/**
 * Claude 상태 글리프 컴포넌트. idle이면 null을 반환해 슬롯 자체를 렌더하지 않는다.
 *
 * 글리프 크기는 design.md §14 기준 12px(size-3). 색 토큰은 semantic CSS 변수 참조.
 * Redundant encoding을 위해 글리프 형태 + 색을 조합한다.
 */
function ClaudeGlyph({ status }: { status: ClaudeStatus }) {
  if (status === "idle") return null;

  // aria-label은 부모가 tabindex가 없는 span에 붙으므로, role="img" + aria-label로
  // 스크린리더가 내용을 읽을 수 있게 한다.
  const label = claudeAriaLabel(status);

  if (status === "running") {
    return (
      <span role="img" aria-label={label}>
        <Loader
          width={12}
          height={12}
          strokeWidth={1.5}
          className="shrink-0 text-(--state-loading-indicator) motion-safe:animate-spin"
        />
      </span>
    );
  }
  if (status === "completed") {
    return (
      <span role="img" aria-label={label}>
        <CircleCheck
          width={12}
          height={12}
          strokeWidth={1.5}
          className="shrink-0 text-(--tab-claude-attention-fg)"
        />
      </span>
    );
  }
  if (status === "needsInput") {
    return (
      <span role="img" aria-label={label}>
        <CircleDot
          width={12}
          height={12}
          strokeWidth={1.5}
          className="shrink-0 text-(--tab-claude-attention-fg)"
        />
      </span>
    );
  }
  if (status === "permissionPending") {
    return (
      <span role="img" aria-label={label}>
        <CircleAlert
          width={12}
          height={12}
          strokeWidth={1.5}
          className="shrink-0 text-(--state-warning-fg)"
        />
      </span>
    );
  }
  if (status === "error") {
    return (
      <span role="img" aria-label={label}>
        <TriangleAlert
          width={12}
          height={12}
          strokeWidth={1.5}
          className="shrink-0 text-(--state-error-fg)"
        />
      </span>
    );
  }
  return null;
}


export interface TabItemProps {
  workspaceId: string;
  leafId: string;
  tab: Tab;
  displayTitle: string;
  parentDirSuffix?: string;
  onCloseTab: (id: string) => void;
  onTabContextMenu?: (tabId: string, event: React.MouseEvent) => void;
}

export function TabItem({
  workspaceId,
  leafId,
  tab,
  displayTitle,
  parentDirSuffix,
  onCloseTab,
  onTabContextMenu,
}: TabItemProps) {
  const payload = useMemo<TabDragPayload>(
    () => ({ workspaceId, tabId: tab.id, sourceGroupId: leafId }),
    [workspaceId, tab.id, leafId],
  );

  const dirty = useTabDirty(tab);
  const terminalEnded = tab.type === "terminal" && Boolean(tab.props.dead);

  // Claude 세션 상태 구독 — status string primitive만 추출해 identity 안정.
  const claudeStatus: ClaudeStatus | undefined = useClaudeStatusStore((state) =>
    selectStatusForTab(state, workspaceId, tab.id)?.status,
  );

  // permissionPending 배경 tint — 탭 배경에 6% warning 색 오버레이.
  const isPermissionPending = claudeStatus === "permissionPending";

  // VSCode anchors the drag image at (0, 0) of the tab DOM so the cursor sits
  // at the top-left corner, leaving room for drop-border feedback.
  const { onDragStart } = useDragSource({
    mime: MIME_TAB,
    payload,
    dragImage: { kind: "self" },
  });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: wrapper owns context menu and drag source; trigger handles tab keyboard interaction
    <div
      key={tab.id}
      className="group relative flex items-center h-full"
      {...{ [DND_TAB_ITEM_ATTR]: "" }}
      draggable
      onDragStart={onDragStart}
      onContextMenu={(e) => onTabContextMenu?.(tab.id, e)}
      // VSCode parity: double-click on a preview tab promotes it. We have no
      // sticky/maximize behaviour to branch on (multiEditorTabsControl checks
      // `isPinned` first, but that's their *sticky* concept) — promote-only.
      onDoubleClick={() => {
        if (tab.isPreview) {
          useTabsStore.getState().promoteFromPreview(workspaceId, tab.id);
        }
      }}
    >
      <RadixTabs.Trigger
        value={tab.id}
        aria-label={terminalEnded ? `${displayTitle}, terminal ended` : undefined}
        className={cn(
          // chip layout — h-7 inset within the h-9 bar; rounded so the active /
          // hover surface reads as a raised chip (JetBrains Islands tab).
          // pr-7 reserves space for the absolute close button.
          "flex items-center gap-2 pl-3 pr-7 h-7 rounded-(--radius-raised)",
          // text
          "text-app-ui-sm whitespace-nowrap select-none cursor-pointer",
          // reset button defaults
          "bg-transparent",
          // rest (inactive): flat, muted text — no surface
          "text-muted-foreground",
          // hover: chip-shaped surface highlight (light-theme safe, design.md §8)
          "hover:bg-[var(--tab-hover-bg)] hover:text-foreground",
          // active (selected): filled raised chip + foreground text. Surface +
          // colour change satisfy §8 redundant encoding. The fill is a
          // within-island raised surface (not a canvas/island swap), so no
          // depth reversal — design.md §2 is about canvas↔island, not this.
          "data-[state=active]:bg-[var(--tab-active-bg)] data-[state=active]:text-foreground",
          // permissionPending 탭 배경 warning tint — 6% opacity, redundant encoding 보조.
          isPermissionPending && "bg-(--state-warning-bg)/[0.06]",
          // focus
          "outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50",
        )}
      >
        {tab.isPinned && <PinIcon />}
        {tab.type === "editor" && (tab.props.readOnly || tab.props.origin === "external") && (
          <span role="img" aria-label="Read-only">
            <Lock
              aria-hidden
              width={12}
              height={12}
              strokeWidth={1.5}
              className="shrink-0 text-muted-foreground"
            />
          </span>
        )}
        {/* Claude 상태 글리프 슬롯 — idle이면 미렌더. 활성/비활성 탭 모두 풀톤 opacity. */}
        {claudeStatus && claudeStatus !== "idle" && (
          <ClaudeGlyph status={claudeStatus} />
        )}
        <span className={tab.isPreview ? "italic" : undefined}>
          {displayTitle}
          {terminalEnded && (
            <span aria-hidden className="text-muted-foreground/60">
              {" "}
              ·
            </span>
          )}
          {parentDirSuffix && (
            <span className="text-muted-foreground/60"> · {parentDirSuffix}</span>
          )}
        </span>
        {/* Dirty indicator — inline after label so it never overlaps the close button.
            Always visible when dirty (including on hover), per design.md §7 redundant encoding. */}
        {dirty && (
          <span aria-hidden className="flex items-center justify-center size-2 shrink-0">
            <span className="size-2 rounded-full bg-[var(--tab-modified-dot)]" />
          </span>
        )}
      </RadixTabs.Trigger>

      {/* Close button with Tooltip — sibling of trigger (never nested inside trigger).
          Always positioned separately from the dirty dot (no replacement).
          Hit target is min-w-6 min-h-6 (24px) per design requirement. */}
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute right-1 top-1/2 -translate-y-1/2 hover:bg-[var(--state-hover-bg)] shrink-0 opacity-50 hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              onCloseTab(tab.id);
            }}
            aria-label="Close tab"
          >
            <X aria-hidden width={12} height={12} strokeWidth={2} />
          </Button>
        </RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            className="px-2 py-1 text-app-micro bg-muted text-foreground border border-border rounded-(--radius-control) shadow-none"
            sideOffset={4}
          >
            Close tab
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </div>
  );
}
