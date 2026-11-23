import { Menu, Settings } from "lucide-react";
import {
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { COMMANDS } from "../../../shared/keybindings/commands";
import {
  locationLabel,
  type WorkspaceLocation,
  type WorkspaceMeta,
} from "../../../shared/types/workspace";
import { ipcCallResult } from "../../ipc/client";
import { shortcutFor } from "../../keybindings/shortcut-labels";
import { useActiveStore } from "../../state/stores/active";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { useSettingsUIStore } from "../../state/stores/settings-ui";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { isMac } from "../../utils/platform";
import { ViewToggle } from "../agent-view/view-toggle";
import { IconButton } from "../ui/icon-button";
import { InboxButton } from "./inbox-button";
import { ReleaseNewsButton } from "./release-news-button";
import { TaskSwitcher } from "./task-switcher";
import { UpdateButton } from "./update-button";
import { WindowControls } from "./window-controls";

const TITLEBAR_HEIGHT_CLASS = "h-9";
const MAC_TRAFFIC_LIGHTS_INSET = 78;
const WIN_OVERLAY_INSET = 140;
const OWN_CONTROLS_INSET = 4;
const CENTER_GAP = 8;

export function TitleBar({
  peerTitle,
}: {
  peerTitle?: (maxWidth: number | undefined) => ReactNode;
}) {
  const { t } = useTranslation();
  const ownControls = window.host.transparentWindow === true;

  const activeWorkspaceId = useActiveStore((s) => s.activeWorkspaceId);
  const activeWorkspace = useWorkspacesStore((s) =>
    activeWorkspaceId ? s.workspaces.find((w) => w.id === activeWorkspaceId) : null,
  );

  const agentView = useAgentViewStore((s) => s.mode === "agents");
  const settingsOpen = useSettingsUIStore((s) => s.settingsOpen);
  const toggleSettings = useSettingsUIStore((s) => s.toggleSettings);

  const barRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const room = useCenterRoom(barRef, startRef, endRef);

  return (
    <div
      ref={barRef}
      role="presentation"
      className={cn(
        "relative flex shrink-0 items-center select-none app-drag backdrop-surface",
        TITLEBAR_HEIGHT_CLASS,
      )}
      style={{
        paddingLeft: isMac() ? MAC_TRAFFIC_LIGHTS_INSET : 12,
        paddingRight: isMac() ? 12 : ownControls ? OWN_CONTROLS_INSET : WIN_OVERLAY_INSET,
      }}
    >
      <div ref={startRef} className="flex shrink-0 items-center">
        {!isMac() && (
          <IconButton
            label={t("titleBar.open_menu")}
            size="md"
            onClick={openAppMenu}
            onMouseDown={(e) => e.preventDefault()}
            aria-haspopup="menu"
            className="app-no-drag -ml-1.5 mr-1.5"
          >
            <Menu className="size-4" aria-hidden="true" />
          </IconButton>
        )}

        <span lang="en" className="text-app-label text-muted-foreground uppercase">
          NexusCode
        </span>

        <ViewToggle />
      </div>

      {!agentView &&
        (peerTitle?.(room) ??
          (activeWorkspace && (
            <TaskSwitcher active={activeWorkspace} label={titleLabel} maxWidth={room} />
          )))}

      <div ref={endRef} className="ml-auto flex shrink-0 items-center">
        <ReleaseNewsButton />

        <UpdateButton />

        <InboxButton />

        <IconButton
          label={t("titleBar.open_settings")}
          shortcut={shortcutFor(COMMANDS.settingsOpen)}
          size="md"
          onClick={toggleSettings}
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          className={cn(
            "app-no-drag ml-0.5",
            settingsOpen && "bg-[var(--state-active-bg)] text-foreground",
          )}
        >
          <Settings className="size-4" aria-hidden="true" />
        </IconButton>

        {ownControls && <WindowControls />}
      </div>
    </div>
  );
}

function useCenterRoom(
  bar: RefObject<HTMLElement | null>,
  start: RefObject<HTMLElement | null>,
  end: RefObject<HTMLElement | null>,
): number | undefined {
  const [room, setRoom] = useState<number>();
  useLayoutEffect(() => {
    const [b, s, e] = [bar.current, start.current, end.current];
    if (!b || !s || !e) return;
    const measure = () => {
      const box = b.getBoundingClientRect();
      const center = box.left + box.width / 2;
      const side = Math.min(
        center - s.getBoundingClientRect().right,
        e.getBoundingClientRect().left - center,
      );
      setRoom(Math.max(0, Math.floor(2 * (side - CENTER_GAP))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const el of [b, s, e]) observer.observe(el);
    return () => observer.disconnect();
  }, [bar, start, end]);
  return room;
}

function openAppMenu(event: MouseEvent<HTMLButtonElement>): void {
  const rect = event.currentTarget.getBoundingClientRect();
  void ipcCallResult("window", "showAppMenu", { x: rect.left, y: rect.bottom });
}

function titleLabel(workspace: WorkspaceMeta): string {
  return workspaceTitleLabel(workspace.name, workspace.location);
}

function workspaceTitleLabel(name: string, location: WorkspaceLocation): string {
  const where = locationLabel(location, { prefix: true });
  return where ? `${name} (${where})` : name;
}
