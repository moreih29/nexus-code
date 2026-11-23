import { Bot, FilePlus, Globe, Plus, SquareTerminal } from "lucide-react";
import { Tabs as RadixTabs } from "radix-ui";
import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DND_TAB_BAR_ATTR } from "@/components/workspace/dnd/markers";
import { fadeMask, useStripOverflow } from "@/hooks/use-strip-overflow";
import { useTabInSight } from "@/hooks/use-tab-in-sight";
import { shortcutFor } from "@/keybindings/shortcut-labels";
import { requestTabFocus } from "@/services/tab-focus";
import { basename } from "@/utils/path";
import { COMMANDS } from "../../../../shared/keybindings/commands";
import { type ShellChoice, sameShellChoice } from "../../../../shared/pty/shell";
import { shellEntries, useInstalledShells } from "../../../services/terminal/installed-shells";
import type { EditorTab, Tab } from "../../../state/stores/tabs";
import { useTerminalStore } from "../../../state/stores/terminal";
import { useWorkspace } from "../../../state/stores/workspaces";
import { NewChatMenuItems } from "../../agent-profiles/new-chat-menu";
import { formatDiffRefPair } from "../../editor/format-diff-refs";
import { useTabBarDropTarget } from "../dnd/use-tab-bar-drop-target";
import { OverflowTabsMenu } from "./overflow-tabs-menu";
import { TabIcon, TabItem } from "./tab-item";

interface TabBarProps {
  workspaceId: string;
  leafId: string;
  tabs: Tab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTerminalTab: (shell?: ShellChoice) => void;
  onNewUntitledTab: () => void;
  onNewBrowserTab: () => void;
  onShowAgentList: () => void;
  onNewClaudeTab: (profileId?: string) => void;
  onNewCodexTab: (profileId?: string) => void;
  onTabContextMenu?: (tabId: string, event: React.MouseEvent) => void;
}

export function TabBar({
  workspaceId,
  leafId,
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTerminalTab,
  onNewUntitledTab,
  onNewBrowserTab,
  onShowAgentList,
  onNewClaudeTab,
  onNewCodexTab,
  onTabContextMenu,
}: TabBarProps) {
  const { t } = useTranslation();
  const { barRef, tabsListRef, insertion } = useTabBarDropTarget({ workspaceId, leafId });
  const stripRef = useRef<HTMLDivElement | null>(null);
  useTabInSight(stripRef, activeTabId, (strip) =>
    strip.querySelector('[role="tab"][data-state="active"]'),
  );

  const isLocal = useWorkspace(workspaceId, (w) => w?.location.kind === "local");
  const installed = useInstalledShells();
  const customShells = useTerminalStore((s) => s.customShells);
  const chosenShell = useTerminalStore((s) => s.shell);
  const entries = isLocal ? shellEntries(t, installed, customShells) : [];
  const menuShells = entries.length > 1 ? entries : [];
  const defaultShell: ShellChoice | undefined =
    chosenShell ?? (installed ? { kind: "detected", id: installed.systemDefault.id } : undefined);

  const sortedTabs = useMemo(() => {
    const pinned = tabs.filter((t) => t.isPinned);
    const unpinned = tabs.filter((t) => !t.isPinned);
    return [...pinned, ...unpinned];
  }, [tabs]);
  const sortedIds = useMemo(() => sortedTabs.map((tab) => tab.id), [sortedTabs]);
  const overflow = useStripOverflow(stripRef, sortedIds, (strip, id) =>
    strip.querySelector(`[data-tab-id="${CSS.escape(id)}"]`),
  );

  const externalTabParentDir = useMemo(() => {
    const suffixMap = new Map<string, string | undefined>();
    const externalTabs = tabs.filter(
      (t): t is EditorTab => t.type === "editor" && t.props.origin === "external",
    );
    const basenameCount = new Map<string, number>();
    for (const t of externalTabs) {
      const name = basename(t.props.filePath);
      basenameCount.set(name, (basenameCount.get(name) ?? 0) + 1);
    }
    for (const t of externalTabs) {
      const name = basename(t.props.filePath);
      if ((basenameCount.get(name) ?? 0) > 1) {
        const parts = t.props.filePath.split("/");
        const parentDir = parts.length >= 2 ? parts[parts.length - 2] : undefined;
        suffixMap.set(t.id, parentDir);
      }
    }
    return suffixMap;
  }, [tabs]);

  const diffTabRefSuffix = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tabs) {
      if (t.type === "editor.diff") {
        map.set(t.id, formatDiffRefPair(t.props.leftRef, t.props.rightRef));
      }
    }
    return map;
  }, [tabs]);

  return (
    <div
      ref={barRef}
      role="status"
      aria-live="polite"
      {...{ [DND_TAB_BAR_ATTR]: "" }}
      className="flex items-center h-9 shrink-0 px-1.5"
    >
      <RadixTabs.Root
        value={activeTabId ?? ""}
        onValueChange={onSelectTab}
        className="flex items-center h-full w-full min-w-0"
      >
        <div
          ref={stripRef}
          className="h-full min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{ maskImage: fadeMask(overflow) }}
        >
          <RadixTabs.List
            ref={tabsListRef}
            className="relative flex items-center h-full w-max"
            aria-label={t("tabBar.open_tabs")}
          >
            {sortedTabs.map((tab) => (
              <TabItem
                key={tab.id}
                workspaceId={workspaceId}
                leafId={leafId}
                tab={tab}
                displayTitle={tab.title}
                parentDirSuffix={diffTabRefSuffix.get(tab.id) ?? externalTabParentDir.get(tab.id)}
                onCloseTab={onCloseTab}
                onTabContextMenu={onTabContextMenu}
              />
            ))}

            {insertion && (
              <div
                aria-hidden
                className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-primary"
                style={{ left: insertion.x, transform: "translateX(-1px)" }}
              />
            )}
          </RadixTabs.List>
        </div>

        <OverflowTabsMenu
          hidden={overflow.hidden}
          renderTab={(id) => {
            const tab = tabs.find((candidate) => candidate.id === id);
            if (!tab) return null;
            const suffix = diffTabRefSuffix.get(id) ?? externalTabParentDir.get(id);
            return (
              <>
                <TabIcon tab={tab} />
                <span className="truncate">{suffix ? `${tab.title} · ${suffix}` : tab.title}</span>
              </>
            );
          }}
          onSelect={(id) => {
            onSelectTab(id);
            requestTabFocus(id);
          }}
        />

        <DropdownMenuRoot>
          <DropdownMenuTrigger>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 text-muted-foreground hover:text-foreground ml-0"
              aria-label={t("tabBar.new_tab")}
            >
              <Plus aria-hidden width={16} height={16} strokeWidth={1.5} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            side="bottom"
            sideOffset={4}
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            <DropdownMenuItem onSelect={() => onNewUntitledTab()}>
              <FilePlus aria-hidden className="size-3.5 mr-1.5 shrink-0" />
              <span className="flex-1">{t("tabBar.new_file")}</span>
              <DropdownMenuShortcut>{shortcutFor(COMMANDS.fileNew)}</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewTerminalTab()}>
              <SquareTerminal aria-hidden className="size-3.5 mr-1.5 shrink-0" />
              <span className="flex-1">{t("tabBar.new_terminal")}</span>
              <DropdownMenuShortcut>{shortcutFor(COMMANDS.terminalNew)}</DropdownMenuShortcut>
            </DropdownMenuItem>
            {menuShells.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <SquareTerminal aria-hidden className="size-3.5 mr-1.5 shrink-0" />
                  <span className="flex-1">{t("tabBar.new_terminal_with")}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {menuShells.map((shell) => (
                    <DropdownMenuItem
                      key={`${shell.choice.kind}:${shell.choice.id}`}
                      onSelect={() => onNewTerminalTab(shell.choice)}
                    >
                      <span className="flex-1">{shell.name}</span>
                      {sameShellChoice(shell.choice, defaultShell) && (
                        <span className="ml-4 text-muted-foreground">
                          {t("tabBar.default_shell")}
                        </span>
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            <DropdownMenuItem onSelect={() => onNewBrowserTab()}>
              <Globe aria-hidden className="size-3.5 mr-1.5 shrink-0" />
              <span className="flex-1">{t("tabBar.new_browser")}</span>
            </DropdownMenuItem>
            <NewChatMenuItems workspaceId={workspaceId} agent="claude" onOpen={onNewClaudeTab} />
            <NewChatMenuItems workspaceId={workspaceId} agent="codex" onOpen={onNewCodexTab} />
            <DropdownMenuItem onSelect={() => onShowAgentList()}>
              <Bot aria-hidden className="size-3.5 mr-1.5 shrink-0" />
              <span className="flex-1">{t("tabBar.agent_list")}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuRoot>
      </RadixTabs.Root>
    </div>
  );
}
