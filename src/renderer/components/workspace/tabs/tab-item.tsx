import {
  CircleAlert,
  CircleCheck,
  File,
  FileDiff,
  GitCommit,
  Globe,
  Loader,
  Lock,
  MessageCircleQuestion,
  SquareTerminal,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import i18next from "i18next";
import { Tabs as RadixTabs, Tooltip as RadixTooltip } from "radix-ui";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useDragSource } from "@/components/ui/use-drag-source";
import { DND_TAB_ITEM_ATTR } from "@/components/workspace/dnd/markers";
import { cacheUriFor } from "@/services/editor/model/cache";
import { isDirty, subscribeFileDirty } from "@/services/editor/model/dirty-tracker";
import { cn } from "@/utils/cn";
import { basename } from "@/utils/path";
import type { ClaudeStatus } from "../../../../shared/claude/status";
import { useBrowserRuntimeStore } from "../../../state/stores/browser-runtime";
import { selectStatusForTab, useClaudeStatusStore } from "../../../state/stores/claude-status";
import { useTabGitDecoration } from "../../../state/stores/git/use-tab-decoration";
import { useTabEditingStore } from "../../../state/stores/tab-editing";
import { type Tab, useTabsStore } from "../../../state/stores/tabs";
import { kindToColorVar } from "../../files/file-tree/git-decoration";
import { getFileIcon } from "../../files/file-tree/icons";
import { MIME_TAB, type TabDragPayload } from "../dnd/types";

/**
 * 브라우저 탭 favicon 표시 — 페이지가 advertise한 URL이 있으면 그것, 없으면 Globe
 * 기본 아이콘. URL 로드 실패(404 / 차단 / 잘못된 URL)는 onError로 Globe fallback.
 *
 * faviconUrl이 바뀌면 errored 상태를 reset해 새 URL을 다시 시도한다.
 * 사이즈 12px(size-3), shrink-0으로 탭 chip 내부에서 텍스트와 정렬.
 */
function BrowserFaviconIcon({ faviconUrl }: { faviconUrl: string | null }) {
  const [errored, setErrored] = useState(false);
  useEffect(() => {
    setErrored(false);
  }, [faviconUrl]);

  if (!faviconUrl || errored) {
    return (
      <Globe
        aria-hidden
        width={12}
        height={12}
        strokeWidth={1.5}
        className="shrink-0 text-muted-foreground"
      />
    );
  }
  return (
    // biome-ignore lint/a11y/useAltText: decorative tab favicon; aria-hidden hides from AT
    <img
      aria-hidden
      src={faviconUrl}
      width={12}
      height={12}
      onError={() => setErrored(true)}
      className="shrink-0 size-3 object-contain"
    />
  );
}

/**
 * 탭 type별 아이콘 결정. browser 탭은 별도 favicon 컴포넌트가 처리하므로 null.
 *
 *  - terminal: SquareTerminal (일관 아이콘)
 *  - editor: 파일 확장자 기반 — 파일트리와 같은 `getFileIcon`을 재사용해 일관성 유지
 *  - editor.diff: FileDiff (좌우 비교 의미)
 *  - git.commit: GitCommit
 *  - untitled: File (저장 전 빈 파일)
 *  - browser: null — favicon 컴포넌트가 별도 슬롯에서 처리
 */
function tabTypeIcon(tab: Tab): LucideIcon | null {
  if (tab.type === "terminal") return SquareTerminal;
  if (tab.type === "editor") return getFileIcon(basename(tab.props.filePath));
  if (tab.type === "editor.diff") return FileDiff;
  if (tab.type === "git.commit") return GitCommit;
  if (tab.type === "untitled") return File;
  return null; // browser
}

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
      return i18next.t("claudeStatus.running");
    case "completed":
      return i18next.t("claudeStatus.completed");
    case "needsInput":
      return i18next.t("claudeStatus.needsInput");
    case "permissionPending":
      return i18next.t("claudeStatus.permissionPending");
    case "error":
      return i18next.t("claudeStatus.error");
    case "idle":
      return i18next.t("claudeStatus.idle");
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
    // completed(정적 체크)와 같은 attention 색 토큰을 공유하므로, pulse 모션과
    // 아이콘(MessageCircleQuestion) 형태로 시각적 구분을 추가한다.
    return (
      <span role="img" aria-label={label} className="motion-safe:animate-pulse">
        <MessageCircleQuestion
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
  /**
   * 라벨 뒤에 `· {suffix}` 형태로 붙는 muted 보조 텍스트. 호출 측이 결정한다:
   *   - 같은 basename의 external 에디터 탭 ≥2개 → 부모 디렉토리 이름.
   *   - diff 탭(editor.diff) → `leftRef..rightRef` ref 쌍.
   */
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
  const { t } = useTranslation();
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

  // 브라우저 탭 favicon — type === "browser"일 때만 runtime store에서 lookup.
  // 다른 type이면 항상 null (조건부 hook 회피를 위해 selector 자체는 항상 호출).
  const faviconUrl = useBrowserRuntimeStore((s) =>
    tab.type === "browser" ? (s.runtimes.get(tab.id)?.faviconUrl ?? null) : null,
  );

  // Git decoration — 파일트리 row와 동일한 시맨틱: editor 탭의 작업트리 상태
  // (modified / added / deleted / untracked / conflict / renamed)를 라벨 색으로,
  // .gitignore 매칭 파일은 opacity-50로 dim한다. editor 외 탭은 hook이 빈 결과 반환.
  const { decoration: gitDecoration, isIgnored: gitIgnored } = useTabGitDecoration(tab);
  const labelColor =
    gitDecoration !== undefined
      ? kindToColorVar(gitDecoration)
      : gitIgnored
        ? kindToColorVar("ignored")
        : undefined;

  // ---------------------------------------------------------------------
  // Inline rename — 터미널 탭만. 더블클릭 또는 컨텍스트 메뉴 "Rename Tab" 진입.
  //
  // 진입 트리거 2개를 동일 store(useTabEditingStore.editingTabId)로 묶어 어느
  // 경로든 같은 모드로 들어간다. 한 번에 한 탭만 편집 가능(store 단일성 보장).
  //
  // 키 핸들링:
  //   - Enter / blur: commit — renameTab(workspaceId, tabId, value)
  //     * 빈 문자열은 store가 customTitle clear로 해석 → processTitle / defaultTitle로 복귀
  //   - Escape: cancel — 값 적용 안 함
  // ---------------------------------------------------------------------
  const isEditing = useTabEditingStore((s) => s.editingTabId === tab.id);
  // 초기 입력값: 사용자가 이전에 지은 customTitle이 있으면 그것, 없으면 표시 title.
  // displayTitle에는 parent-dir suffix 등이 포함될 수 있는데 그건 호출 측 가공이므로
  // 편집 input에는 tab.customTitle ?? tab.title을 사용한다.
  const [editValue, setEditValue] = useState(tab.customTitle ?? tab.title);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 편집 모드 진입 시: 최신 customTitle/title을 input value로 초기화 + focus/select.
  // (이전 편집 세션의 stale value를 들고 들어가지 않도록 진입 시점에 reset.)
  useEffect(() => {
    if (!isEditing) return;
    setEditValue(tab.customTitle ?? tab.title);
    // focus는 다음 paint에 — input mount 이후 보장.
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [isEditing, tab.customTitle, tab.title]);

  function commitEdit(value: string): void {
    useTabsStore.getState().renameTab(workspaceId, tab.id, value);
    useTabEditingStore.getState().cancelEditing();
  }

  function cancelEdit(): void {
    useTabEditingStore.getState().cancelEditing();
  }

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
      // 더블클릭 동작은 탭 type별로 분기:
      //  - terminal: inline rename 진입 (사용자 요구 — 컨텍스트 메뉴 Rename과 동일 경로)
      //  - 그 외 isPreview 탭: VSCode parity로 promote-from-preview
      // terminal 탭은 isPreview일 일이 없으므로 두 분기가 mutually exclusive.
      onDoubleClick={() => {
        if (tab.type === "terminal") {
          useTabEditingStore.getState().startEditing(tab.id);
          return;
        }
        if (tab.isPreview) {
          useTabsStore.getState().promoteFromPreview(workspaceId, tab.id);
        }
      }}
    >
      <RadixTabs.Trigger
        value={tab.id}
        aria-label={terminalEnded ? `${displayTitle}${t("tabBar.terminal_ended_aria")}` : undefined}
        className={cn(
          // chip layout — h-7 inset within the h-9 bar; rounded so the active /
          // hover surface reads as a raised chip (JetBrains Islands tab).
          // pr-7 reserves space for the absolute close button.
          // relative: positioning context for the active-state ::after underline.
          "relative flex items-center gap-2 pl-3 pr-7 h-7 rounded-(--radius-raised)",
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
          // active accent underline — JetBrains Islands canon (EditorTabs.underline*):
          // 2px tall bottom-edge line, inset 8px on each side, fully rounded ends.
          // 사이드바와 동일한 --state-selected-indicator 토큰 공유 → "이 파랑은
          // 활성 의미"라는 색 어휘를 유지하면서 위치만 변주(세로 리스트=좌측 2px,
          // 가로 탭=하단 2px). 그레이스케일에서도 위치 단서가 잔존해 접근성 OK.
          "data-[state=active]:after:content-['']",
          "data-[state=active]:after:absolute data-[state=active]:after:left-2 data-[state=active]:after:right-2",
          "data-[state=active]:after:bottom-0 data-[state=active]:after:h-0.5",
          "data-[state=active]:after:rounded-full",
          "data-[state=active]:after:bg-[var(--state-selected-indicator)]",
          // preview tab + active: italic 라벨이 "임시 활성"을 이미 신호하므로
          // underline alpha를 60%로 낮춰 "정착되지 않은 선택"임을 보조 표현.
          // dirty가 발생해 promoteFromPreview되면 isPreview=false가 되어 자동 복원.
          tab.isPreview && "data-[state=active]:after:opacity-60",
          // inactive tab의 보조 아이콘(Pin/Lock/Claude 글리프)을 65% alpha로
          // 감쇠 — JB canon `EditorTabs.unselectedAlpha` 대응. 활성 탭은 풀톤
          // 유지로 시각적 우선순위를 명확히 한다. 텍스트는 이미 text-muted-foreground
          // 로 dim 처리되어 있으므로 추가 opacity 안 적용(이중 dim 방지).
          "data-[state=inactive]:[&_[data-tab-icon]]:opacity-65",
          // permissionPending 탭 배경 warning tint — 6% opacity, redundant encoding 보조.
          isPermissionPending && "bg-(--state-warning-bg)/[0.06]",
          // focus
          "outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50",
        )}
      >
        {tab.isPinned && (
          <span data-tab-icon className="inline-flex">
            <PinIcon />
          </span>
        )}
        {/* Type 아이콘 — browser는 favicon, 그 외는 파일트리와 동일한 확장자 기반 또는
            전용 lucide 아이콘. 가장 앞쪽(pin 다음)에 두어 탭 타입을 즉각 식별 가능. */}
        {tab.type === "browser" ? (
          <span data-tab-icon className="inline-flex" aria-hidden>
            <BrowserFaviconIcon faviconUrl={faviconUrl} />
          </span>
        ) : (() => {
          const TypeIcon = tabTypeIcon(tab);
          if (!TypeIcon) return null;
          return (
            <span data-tab-icon className="inline-flex" aria-hidden>
              <TypeIcon
                width={12}
                height={12}
                strokeWidth={1.5}
                className="shrink-0 text-muted-foreground"
              />
            </span>
          );
        })()}
        {tab.type === "editor" && (tab.props.readOnly || tab.props.origin === "external") && (
          <span data-tab-icon role="img" aria-label={t("tabBar.read_only_aria")}>
            <Lock
              aria-hidden
              width={12}
              height={12}
              strokeWidth={1.5}
              className="shrink-0 text-muted-foreground"
            />
          </span>
        )}
        {/* Claude 상태 글리프 슬롯 — idle이면 미렌더. data-tab-icon 마커로
            비활성 탭에서는 65% alpha로 감쇠된다(활성 탭은 풀톤 유지). */}
        {claudeStatus && claudeStatus !== "idle" && (
          <span data-tab-icon className="inline-flex">
            <ClaudeGlyph status={claudeStatus} />
          </span>
        )}
        {isEditing ? (
          // Inline rename input — 트리거 내부에 위치하므로 클릭/키보드 이벤트가
          // RadixTabs.Trigger로 bubble하지 않도록 stopPropagation. Enter commit,
          // Escape cancel, blur는 commit으로 처리(macOS 텍스트 필드 컨벤션).
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                commitEdit(editValue);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                cancelEdit();
              } else {
                // 다른 키는 input 내부 처리에 위임하되 트리거로 bubble은 막는다
                // (예: ArrowLeft/Right로 탭 전환되는 등 키바인딩 충돌 방지).
                e.stopPropagation();
              }
            }}
            onBlur={() => commitEdit(editValue)}
            onClick={(e) => e.stopPropagation()}
            // 입력 모드에서는 부모 트리거가 active state로 잡혀 있어도 input이
            // 시각적으로 자연스럽게 노출되도록 transparent 배경 + 인라인 폭.
            className="bg-transparent outline-none border-0 px-0 m-0 w-32 text-app-ui-sm text-foreground"
            aria-label={t("tabBar.rename_tab")}
            spellCheck={false}
          />
        ) : (
          <span
            className={cn(
              tab.isPreview && "italic",
              // Ignored 파일 탭은 라벨이 receded — 파일트리 row와 동일한 신호.
              gitIgnored && "opacity-50",
            )}
            // Inline color는 active 탭의 text-foreground / inactive 의 text-muted-foreground
            // cascade를 모두 이긴다 (선택 상태에서도 git 색이 살아남). undefined일 땐
            // 기존 색 그대로 상속.
            style={labelColor ? { color: labelColor } : undefined}
          >
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
        )}
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
            aria-label={t("tabBar.close_tab")}
          >
            <X aria-hidden width={12} height={12} strokeWidth={2} />
          </Button>
        </RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            className="px-2 py-1 text-app-micro bg-muted text-foreground border border-border rounded-(--radius-control) shadow-none"
            sideOffset={4}
          >
            {t("tabBar.close_tab")}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </div>
  );
}
