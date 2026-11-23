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
  NotebookPen,
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
import {
  ContextMenuContent,
  ContextMenuItems,
  ContextMenuRoot,
  ContextMenuTrigger,
  type MenuItemSpec,
} from "@/components/ui/context-menu";
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
import { useChatTabStatus } from "../../../services/agent-sessions/use-codex-status";
import { useEstimatedTabGlyph } from "../../../services/agent-sessions/use-estimated";
import { useSessionParent } from "../../../services/agent-sessions/use-session-parent";
import { useBrowserRuntimeStore } from "../../../state/stores/browser-runtime";
import { selectStatusForTab, useClaudeStatusStore } from "../../../state/stores/claude-status";
import { useTabGitDecoration } from "../../../state/stores/git/use-tab-decoration";
import { useTabEditingStore } from "../../../state/stores/tab-editing";
import { type Tab, useTabsStore } from "../../../state/stores/tabs";
import { MIME_TAB, type TabDragPayload } from "../../../types/workbench-dnd";
import { codexStatusLabel, estimatedLabel } from "../../agent-list/session-status";
import { TabProfileMark } from "../../agent-profiles/tab-profile";
import { ClaudeIcon, CodexIcon } from "../../chat/agent-icons";
import { GoalTabBadge } from "../../chat/goal-bar";
import { FileIcon } from "../../files/file-tree/file-icon";
import { kindToColorVar } from "../../files/file-tree/git-decoration";
import { followRenameDraft, type RenameDraft } from "./rename-draft";

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

function tabTypeIcon(tab: Tab): LucideIcon | null {
  if (tab.type === "terminal") return SquareTerminal;
  if (tab.type === "editor.diff") return FileDiff;
  if (tab.type === "git.commit") return GitCommit;
  if (tab.type === "untitled") return File;
  if (tab.type === "claude") return ClaudeIcon;
  if (tab.type === "codex") return CodexIcon;
  if (tab.type === "note") return NotebookPen;
  return null;
}

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

export function useTabDirty(tab: Tab): boolean {
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

function ClaudeGlyph({
  status,
  estimated = false,
  codex = false,
}: {
  status: ClaudeStatus;
  estimated?: boolean;
  codex?: boolean;
}) {
  if (status === "idle") return null;

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
  parentDirSuffix?: string;
  onCloseTab: (id: string) => void;
  onTabContextMenu?: (tabId: string, event: React.MouseEvent) => void;
}

const TAB_TRIGGER_CLASS = cn(
  "relative flex items-center gap-2 pl-3 pr-7 h-7 rounded-(--radius-raised)",
  "text-app-ui-sm whitespace-nowrap select-none cursor-pointer",
  "bg-transparent",
  "text-muted-foreground",
  "hover:bg-[var(--tab-hover-bg)] hover:text-foreground",
  "data-[state=active]:bg-[var(--tab-active-bg)] data-[state=active]:text-foreground",
  "data-[state=active]:after:content-['']",
  "data-[state=active]:after:absolute data-[state=active]:after:left-2 data-[state=active]:after:right-2",
  "data-[state=active]:after:bottom-0 data-[state=active]:after:h-0.5",
  "data-[state=active]:after:rounded-full",
  "data-[state=active]:after:bg-[var(--state-selected-indicator)]",
  "outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50",
);

interface ReadonlyTabItemProps {
  readOnly: true;
  value: string;
  label: string;
  icon: React.ReactNode;
  glyph?: React.ReactNode;
  menu?: readonly MenuItemSpec[];
  onClose: () => void;
}

export function TabItem(props: TabItemProps | ReadonlyTabItemProps) {
  return "readOnly" in props ? <ReadonlyTabItem {...props} /> : <LocalTabItem {...props} />;
}

function ReadonlyTabItem({ value, label, icon, glyph, menu, onClose }: ReadonlyTabItemProps) {
  const item = (
    <div className="group relative flex h-full items-center" data-tab-id={value}>
      <RadixTabs.Trigger
        value={value}
        className={cn(TAB_TRIGGER_CLASS, "data-[state=inactive]:[&_[data-tab-icon]]:opacity-65")}
      >
        {icon}
        {glyph && (
          <span data-tab-icon className="inline-flex">
            {glyph}
          </span>
        )}
        <span className="min-w-0 max-w-64 truncate" title={label}>
          {label}
        </span>
      </RadixTabs.Trigger>
      <TabCloseButton onClose={onClose} />
    </div>
  );
  if (!menu?.length) return item;
  return (
    <ContextMenuRoot>
      <ContextMenuTrigger>{item}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItems items={[...menu]} />
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}

const LocalTabItem = memo(function LocalTabItem({
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

  const opener =
    tab.type === "claude" || tab.type === "codex" || tab.type === "terminal"
      ? tab.props.openedBy
      : undefined;
  const { name, open } = useSessionParent(opener);
  const parentName =
    name ||
    (opener?.tabId && !opener.device && !open
      ? t("agentView.list.closed_conversation")
      : undefined);
  const parent =
    parentName && opener?.device
      ? `${opener.device.name || opener.device.id} · ${parentName}`
      : parentName;
  const title = parent
    ? `${displayTitle} · ${t("agentView.list.parent_hint", { name: parent })}`
    : displayTitle;
  const dirty = useTabDirty(tab);
  const terminalEnded = tab.type === "terminal" && Boolean(tab.props.dead);

  const brokerStatus = useClaudeStatusStore(
    (state) => selectStatusForTab(state, workspaceId, tab.id)?.status,
  );
  const chatStatus = useChatTabStatus(workspaceId, tab);
  const claudeStatus =
    tab.type === "claude" && brokerStatus === "completed"
      ? (chatStatus ?? brokerStatus)
      : brokerStatus;

  const estimatedStatus = useEstimatedTabGlyph(workspaceId, tab, claudeStatus === undefined);

  const codexStatus = tab.type === "codex" && chatStatus !== "idle" ? chatStatus : undefined;

  const isPermissionPending =
    claudeStatus === "permissionPending" || codexStatus === "permissionPending";

  const { decoration: gitDecoration, isIgnored: gitIgnored } = useTabGitDecoration(tab);
  const labelColor =
    gitDecoration !== undefined
      ? kindToColorVar(gitDecoration)
      : gitIgnored
        ? kindToColorVar("ignored")
        : undefined;

  const isEditing = useTabEditingStore((s) => s.editingTabId === tab.id);
  const [renameDraft, setRenameDraft] = useState<RenameDraft>(() => ({
    editing: false,
    value: tab.customTitle ?? tab.title,
  }));
  const nextRenameDraft = followRenameDraft(renameDraft, isEditing, tab.customTitle ?? tab.title);
  if (nextRenameDraft !== renameDraft) setRenameDraft(nextRenameDraft);
  const editValue = nextRenameDraft.value;
  function setEditValue(value: string): void {
    setRenameDraft((draft) => ({ ...draft, value }));
  }
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isEditing) return;
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [isEditing]);

  function commitEdit(value: string): void {
    useTabsStore.getState().renameTab(workspaceId, tab.id, value);
    useTabEditingStore.getState().cancelEditing();
  }

  function cancelEdit(): void {
    useTabEditingStore.getState().cancelEditing();
  }

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
        onClick={(e) => {
          if (e.detail <= 1 && !e.ctrlKey && !isEditing) requestTabFocus(tab.id);
        }}
        aria-label={terminalEnded ? `${displayTitle}${t("tabBar.terminal_ended_aria")}` : undefined}
        className={cn(
          TAB_TRIGGER_CLASS,
          tab.isPreview && "data-[state=active]:after:opacity-60",
          "data-[state=inactive]:[&_[data-tab-icon]]:opacity-65",
          isPermissionPending && "bg-(--state-warning-bg)/[0.06]",
        )}
      >
        {tab.isPinned && (
          <span data-tab-icon className="inline-flex">
            <PinIcon />
          </span>
        )}
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
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if (isImeComposing(e)) {
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
                e.stopPropagation();
              }
            }}
            onKeyUp={(e) => {
              if (e.key === " ") e.preventDefault();
            }}
            onBlur={() => commitEdit(editValue)}
            onClick={(e) => e.stopPropagation()}
            className="bg-transparent outline-none border-0 px-0 m-0 w-32 text-app-ui-sm text-foreground"
            aria-label={t("tabBar.rename_tab")}
            spellCheck={false}
          />
        ) : (
          <span
            title={title}
            className={cn(
              "min-w-0 max-w-64 truncate",
              tab.isPreview && "italic",
              gitIgnored && "opacity-50",
            )}
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
        {dirty && (
          <span aria-hidden className="flex items-center justify-center size-2 shrink-0">
            <span className="size-2 rounded-full bg-[var(--tab-modified-dot)]" />
          </span>
        )}
      </RadixTabs.Trigger>

      <TabCloseButton
        onClose={() => onCloseTab(tab.id)}
        shortcut={shortcutFor(COMMANDS.tabClose)}
      />
    </div>
  );
});

function TabCloseButton({ onClose, shortcut }: { onClose: () => void; shortcut?: string }) {
  const { t } = useTranslation();
  const label = t("tabBar.close_tab");
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="absolute right-1 top-1/2 -translate-y-1/2 hover:bg-[var(--state-hover-bg)] shrink-0 opacity-50 hover:opacity-100"
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
      aria-label={label}
      {...tooltipProps(label, shortcut)}
    >
      <X aria-hidden width={12} height={12} strokeWidth={2} />
    </Button>
  );
}
