import i18next from "i18next";
import {
  CircleAlert,
  CircleCheck,
  File,
  FileDiff,
  GitCommit,
  Globe,
  Loader,
  Lock,
  type LucideIcon,
  MessageCircleQuestion,
  SquareTerminal,
  TriangleAlert,
  X,
} from "lucide-react";
import { Tabs as RadixTabs } from "radix-ui";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { tooltipProps } from "@/components/ui/tooltip";
import { useDragSource } from "@/components/ui/use-drag-source";
import { DND_TAB_ITEM_ATTR } from "@/components/workspace/dnd/markers";
import { shortcutFor } from "@/keybindings/shortcut-labels";
import { cacheUriFor } from "@/services/editor/model/cache";
import { isDirty, subscribeFileDirty } from "@/services/editor/model/dirty-tracker";
import { useDiffWorkingFile } from "@/services/editor/tabs";
import { requestTabFocus } from "@/services/tab-focus";
import { cn } from "@/utils/cn";
import { isImeComposing } from "@/utils/ime";
import { basename } from "@/utils/path";
import type { ClaudeStatus } from "../../../../shared/claude/status";
import { COMMANDS } from "../../../../shared/keybindings/commands";
import { useCodexTabStatus } from "../../../services/agent-sessions/use-codex-status";
import { useEstimatedTabGlyph } from "../../../services/agent-sessions/use-estimated";
import { useBrowserRuntimeStore } from "../../../state/stores/browser-runtime";
import { selectStatusForTab, useClaudeStatusStore } from "../../../state/stores/claude-status";
import { useTabGitDecoration } from "../../../state/stores/git/use-tab-decoration";
import { useTabEditingStore } from "../../../state/stores/tab-editing";
import { type Tab, useTabsStore } from "../../../state/stores/tabs";
import { codexStatusLabel, estimatedLabel } from "../../agent-list/session-status";
import { TabProfileMark } from "../../agent-profiles/tab-profile";
import { ClaudeIcon, CodexIcon } from "../../chat/agent-icons";
import { GoalTabBadge } from "../../chat/goal-bar";
import { FileIcon } from "../../files/file-tree/file-icon";
import { kindToColorVar } from "../../files/file-tree/git-decoration";
import { MIME_TAB, type TabDragPayload } from "../dnd/types";

/**
 * Browser tab favicon: the page-advertised URL if there is one, otherwise the default
 * Globe icon. A URL that fails to load (404 / blocked / malformed) falls back to Globe
 * through onError.
 *
 * Keyed by faviconUrl where it is drawn, so a new URL starts it over and is tried again.
 * 12px (size-3) with shrink-0 so it lines up with the text inside the tab chip.
 */
function BrowserFaviconIcon({ faviconUrl }: { faviconUrl: string | null }) {
  const [errored, setErrored] = useState(false);

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
 * Picks the icon for each tab type. Browser and editor tabs return null.
 *
 *  - terminal: SquareTerminal (one icon for all terminals)
 *  - editor: null — rendered as <FileIcon> in the render path below (theme-aware)
 *  - editor.diff: FileDiff (stands for side-by-side comparison)
 *  - git.commit: GitCommit
 *  - untitled: File (an empty file that has not been saved)
 *  - browser: null — the favicon component handles it in a separate slot
 */
function tabTypeIcon(tab: Tab): LucideIcon | null {
  if (tab.type === "terminal") return SquareTerminal;
  if (tab.type === "editor.diff") return FileDiff;
  if (tab.type === "git.commit") return GitCommit;
  if (tab.type === "untitled") return File;
  if (tab.type === "claude") return ClaudeIcon;
  if (tab.type === "codex") return CodexIcon;
  return null; // editor (handled via FileIcon) and browser (handled via BrowserFaviconIcon)
}

/**
 * A tab's type icon: a browser tab's favicon, an editor tab's file icon
 * (theme-aware), otherwise its type's lucide icon. The tab strip's overflow
 * menu shows it too.
 */
export function TabIcon({ tab }: { tab: Tab }) {
  const faviconUrl = useBrowserRuntimeStore((s) =>
    tab.type === "browser" ? (s.runtimes.get(tab.id)?.faviconUrl ?? null) : null,
  );
  if (tab.type === "browser") {
    return (
      <span data-tab-icon className="inline-flex" aria-hidden>
        <BrowserFaviconIcon key={faviconUrl ?? ""} faviconUrl={faviconUrl} />
      </span>
    );
  }
  if (tab.type === "editor") {
    return (
      <span data-tab-icon className="inline-flex" aria-hidden>
        <FileIcon
          kind="file"
          name={basename(tab.props.filePath)}
          size="sm"
          tone="muted"
          className="shrink-0"
        />
      </span>
    );
  }
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
 * Subscribe to dirty state for an editor tab, or for the working-tree file a
 * diff tab edits. Returns false for other tabs and for tabs whose model has
 * not yet been attached (the tracker creates entries lazily on model load).
 */
function useTabDirty(tab: Tab): boolean {
  const diffWorkingFile = useDiffWorkingFile(tab.type === "editor.diff" ? tab.props : null);
  const filePath = tab.type === "editor" ? tab.props.filePath : diffWorkingFile;
  const cacheUri =
    filePath !== null && (tab.type === "editor" || tab.type === "editor.diff")
      ? cacheUriFor(tab.props.workspaceId, filePath)
      : null;
  const subscribe = useCallback(
    (cb: () => void) => (cacheUri ? subscribeFileDirty(cacheUri, cb) : () => {}),
    [cacheUri],
  );
  const getSnapshot = useCallback(() => (cacheUri ? isDirty(cacheUri) : false), [cacheUri]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/**
 * Returns the aria-label text for a Claude status.
 * Screen readers read an explicit label such as "Claude: permission request".
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
 * Claude status glyph component. Returns null when idle so the slot is not rendered at all.
 *
 * Glyph size is 12px (size-3) per design.md §14. Colors reference semantic CSS variables.
 * The glyph shape and the color are combined for redundant encoding.
 */
function ClaudeGlyph({
  status,
  estimated = false,
  codex = false,
}: {
  status: ClaudeStatus;
  estimated?: boolean;
  /** A Codex tab's state, read from its conversation: named as Codex's. */
  codex?: boolean;
}) {
  if (status === "idle") return null;

  // The parent attaches the aria-label to a span without tabindex, so role="img" +
  // aria-label lets screen readers read the content. A status inferred from output (Codex
  // etc.) is marked "(추정)" like session tabs, and is also shown on hover.
  const label = estimated
    ? estimatedLabel(status)
    : codex
      ? codexStatusLabel(status)
      : claudeAriaLabel(status);
  const title = estimated ? label : undefined;

  if (status === "running") {
    return (
      <span role="img" aria-label={label} title={title}>
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
      <span role="img" aria-label={label} title={title}>
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
    // It shares the attention color token with completed (static check), so the pulse motion
    // and the icon shape (MessageCircleQuestion) add the visual distinction.
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
   * Muted secondary text appended after the label as `· {suffix}`. The caller decides it:
   *   - two or more external editor tabs with the same basename → parent directory name.
   *   - diff tab (editor.diff) → the `leftRef..rightRef` ref pair.
   */
  parentDirSuffix?: string;
  onCloseTab: (id: string) => void;
  onTabContextMenu?: (tabId: string, event: React.MouseEvent) => void;
}

// Memo: the bar renders as which tabs fit changes, which changes no tab.
export const TabItem = memo(function TabItem({
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

  // Subscribe to the Claude session status — extract only the status string primitive
  const claudeStatus: ClaudeStatus | undefined = useClaudeStatusStore(
    (state) => selectStatusForTab(state, workspaceId, tab.id)?.status,
  );

  // Agent terminals with no Claude status (Codex etc.) show a status inferred from output.
  const estimatedStatus = useEstimatedTabGlyph(workspaceId, tab, claudeStatus === undefined);

  // Codex tabs show the status read from the conversation.
  const codexStatus = useCodexTabStatus(workspaceId, tab);

  // permissionPending background tint — a 6% warning color overlay on the tab background.
  const isPermissionPending =
    claudeStatus === "permissionPending" || codexStatus === "permissionPending";

  // Browser tab favicon — looked up in the runtime store only when type === "browser".
  // Always null for other types (the selector is always called to avoid a conditional hook).

  // Git decoration — same semantics as file tree rows: the editor tab's working-tree state
  // (modified / added / deleted / untracked / conflict / renamed) colors the label, and
  // files matching .gitignore are dimmed with opacity-50. Non-editor tabs get an empty result.
  const { decoration: gitDecoration, isIgnored: gitIgnored } = useTabGitDecoration(tab);
  const labelColor =
    gitDecoration !== undefined
      ? kindToColorVar(gitDecoration)
      : gitIgnored
        ? kindToColorVar("ignored")
        : undefined;

  // ---------------------------------------------------------------------
  // Inline rename — terminal and Claude tabs only. Entered by double-click or "Rename Tab".
  //
  // Both entry triggers go through the same store (useTabEditingStore.editingTabId), so
  // either path enters the same mode. Only one tab can be edited at a time (the store
  // holds a single id).
  //
  // Key handling:
  //   - Enter / blur: commit — renameTab(workspaceId, tabId, value)
  //     * An empty string is read by the store as clearing customTitle → back to processTitle / defaultTitle
  //   - Escape: cancel — the value is not applied
  // ---------------------------------------------------------------------
  const isEditing = useTabEditingStore((s) => s.editingTabId === tab.id);
  // Initial input value: the customTitle the user set earlier if any, otherwise the display
  // title. displayTitle may include a parent-dir suffix etc., which the caller adds, so the
  // edit input uses tab.customTitle ?? tab.title.
  const [editValue, setEditValue] = useState(tab.customTitle ?? tab.title);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // On entering edit mode: reset the input value to the latest customTitle/title, then
  // focus/select. (Reset at entry so no stale value from an earlier edit session is kept.)
  useEffect(() => {
    if (!isEditing) return;
    setEditValue(tab.customTitle ?? tab.title);
    // Focus on the next paint — guaranteed to be after the input mounts.
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
      data-tab-id={tab.id}
      {...{ [DND_TAB_ITEM_ATTR]: "" }}
      draggable
      onDragStart={onDragStart}
      onContextMenu={(e) => onTabContextMenu?.(tab.id, e)}
      // Double-click behavior depends on the tab type:
      //  - terminal, claude: enter inline rename (same path as the context menu Rename)
      //  - other isPreview tabs: promote-from-preview, as in VSCode
      // terminal and claude tabs are never isPreview, so the two branches are mutually exclusive.
      onDoubleClick={() => {
        if (tab.type === "terminal" || tab.type === "claude" || tab.type === "codex") {
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
        // A click (or Enter / Space) hands focus to the tab's content so the
        // user can type right away. Not on arrow keys: Radix activates the tab
        // as the user arrows through the strip, and focus must stay there. Not
        // on the second click of a double-click either, which starts a rename
        // that focuses its own input, nor while the name is being edited.
        onClick={(e) => {
          if (e.detail <= 1 && !e.ctrlKey && !isEditing) requestTabFocus(tab.id);
        }}
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
          // Shares the --state-selected-indicator token with the sidebar, keeping the color
          // vocabulary "this blue means active" while only the position varies (vertical list =
          // left 2px, horizontal tabs = bottom 2px). The position cue survives in grayscale.
          "data-[state=active]:after:content-['']",
          "data-[state=active]:after:absolute data-[state=active]:after:left-2 data-[state=active]:after:right-2",
          "data-[state=active]:after:bottom-0 data-[state=active]:after:h-0.5",
          "data-[state=active]:after:rounded-full",
          "data-[state=active]:after:bg-[var(--state-selected-indicator)]",
          // preview tab + active: the italic label already signals "temporarily active", so the
          // underline alpha is lowered to 60% as a secondary cue for "selection not settled".
          // When it turns dirty and promoteFromPreview runs, isPreview=false restores it.
          tab.isPreview && "data-[state=active]:after:opacity-60",
          // The secondary icons of an inactive tab (Pin/Lock/Claude glyph) are attenuated to 65%
          // alpha — matches JB canon `EditorTabs.unselectedAlpha`. The active tab keeps full tone
          // so visual priority is clear. The text is already dimmed with text-muted-foreground, so
          // no extra opacity is applied (avoids double dimming).
          "data-[state=inactive]:[&_[data-tab-icon]]:opacity-65",
          // permissionPending tab background warning tint — 6% opacity, a secondary redundant encoding.
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
        {/* Type icon — placed first (after the pin) so the tab type is recognizable at a glance. */}
        <TabIcon tab={tab} />
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
        {/* Claude status glyph slot — not rendered when idle. The data-tab-icon marker
                   attenuates it to 65% alpha on inactive tabs (the active tab keeps full tone). */}
        {claudeStatus && claudeStatus !== "idle" && (
          <span data-tab-icon className="inline-flex">
            <ClaudeGlyph status={claudeStatus} />
          </span>
        )}
        {estimatedStatus && (
          <span data-tab-icon className="inline-flex">
            <ClaudeGlyph status={estimatedStatus} estimated />
          </span>
        )}
        {codexStatus && (
          <span data-tab-icon className="inline-flex">
            <ClaudeGlyph status={codexStatus} codex />
          </span>
        )}
        {isEditing ? (
          // Inline rename input — it sits inside the trigger, so stopPropagation keeps click/keyboard
          // events from bubbling to RadixTabs.Trigger. Enter commits, Escape cancels, and blur
          // commits (macOS text field convention).
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if (isImeComposing(e)) {
                // Enter/Escape that ends a composition belongs to the IME.
                e.stopPropagation();
              } else if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                commitEdit(editValue);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                cancelEdit();
              } else {
                // Other keys are left to the input but not allowed to bubble to the trigger
                // (avoids keybinding conflicts such as ArrowLeft/Right switching tabs).
                e.stopPropagation();
              }
            }}
            // The field sits in the tab's <button>: releasing Space in it
            // would press the button, whose click hands the focus to the
            // tab's content mid-name ("renamed t").
            onKeyUp={(e) => {
              if (e.key === " ") e.preventDefault();
            }}
            onBlur={() => commitEdit(editValue)}
            onClick={(e) => e.stopPropagation()}
            // In input mode the input should show naturally even when the parent trigger is in the
            // active state, so it uses a transparent background + inline width.
            className="bg-transparent outline-none border-0 px-0 m-0 w-32 text-app-ui-sm text-foreground"
            aria-label={t("tabBar.rename_tab")}
            spellCheck={false}
          />
        ) : (
          <span
            // A long title (a chat's first message, a page's title) is cut
            // to a tab's width; the whole of it shows on hover.
            title={displayTitle}
            className={cn(
              "min-w-0 max-w-64 truncate",
              tab.isPreview && "italic",
              // The label of an ignored file's tab recedes — the same signal as file tree rows.
              gitIgnored && "opacity-50",
            )}
            // The inline color beats both the active tab's text-foreground and the inactive tab's
            // text-muted-foreground cascade (the git color survives in the selected state too). When
            // undefined, the existing color is inherited.
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
        {(tab.type === "claude" || tab.type === "codex") && !isEditing && (
          <GoalTabBadge workspaceId={workspaceId} tabId={tab.id} />
        )}
        {(tab.type === "claude" || tab.type === "codex") && !isEditing && (
          <TabProfileMark agent={tab.type} profileId={tab.props.profileId} />
        )}
        {/* Dirty indicator — inline after label so it never overlaps the close button.
            Always visible when dirty (including on hover), per design.md §7 redundant encoding. */}
        {dirty && (
          <span aria-hidden className="flex items-center justify-center size-2 shrink-0">
            <span className="size-2 rounded-full bg-[var(--tab-modified-dot)]" />
          </span>
        )}
      </RadixTabs.Trigger>

      {/* Close button — sibling of trigger (never nested inside trigger).
          Always positioned separately from the dirty dot (no replacement).
          Hit target is min-w-6 min-h-6 (24px) per design requirement. */}
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute right-1 top-1/2 -translate-y-1/2 hover:bg-[var(--state-hover-bg)] shrink-0 opacity-50 hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onCloseTab(tab.id);
        }}
        aria-label={t("tabBar.close_tab")}
        {...tooltipProps(t("tabBar.close_tab"), shortcutFor(COMMANDS.tabClose))}
      >
        <X aria-hidden width={12} height={12} strokeWidth={2} />
      </Button>
    </div>
  );
});
