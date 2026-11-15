import { Menu, Settings } from "lucide-react";
import { type MouseEvent, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { COMMANDS } from "../../../shared/keybindings/commands";
import type { WorkspaceLocation, WorkspaceMeta } from "../../../shared/types/workspace";
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

// ---------------------------------------------------------------------------
// TitleBar — custom frameless titlebar
//
// Native chrome configuration (see src/main/window.ts):
//   - macOS:    `titleBarStyle: "hiddenInset"` keeps the traffic lights at
//               top-left. We pad the bar's left edge to clear them.
//   - Win/Linux: `titleBarOverlay` renders themed min/max/close at top-right.
//               We pad the bar's right edge to clear that overlay.
//   - Transparent Linux window: no overlay; WindowControls draws the
//               controls at the bar's right end.
//   - Win/Linux show no menu bar under the hidden title bar: a menu button
//               at the bar's left end opens the app menu.
//
// Drag region is applied via the `app-drag` utility (see globals.css);
// interactive children MUST opt out with the `app-no-drag` utility.
// ---------------------------------------------------------------------------

const TITLEBAR_HEIGHT_CLASS = "h-9"; // 36px — matches main/window.ts TITLEBAR_HEIGHT
const MAC_TRAFFIC_LIGHTS_INSET = 78; // px — clears the three traffic-light buttons
const WIN_OVERLAY_INSET = 140; // px — clears the Electron-rendered control overlay
const OWN_CONTROLS_INSET = 4; // px — right of the renderer-drawn window controls
const CENTER_GAP = 8; // px — between the centered title and what is beside it

export function TitleBar() {
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
        // backdrop-surface provides the window-opacity-aware background.
        // At opacity 1 (default) it is fully opaque; below 1 it becomes translucent.
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
            // Focus stays where it was, so Edit's items act on the editor or
            // input the user was in.
            onMouseDown={(e) => e.preventDefault()}
            aria-haspopup="menu"
            className="app-no-drag -ml-1.5 mr-1.5"
          >
            <Menu className="size-4" aria-hidden="true" />
          </IconButton>
        )}

        {/* Brand — uppercase small-label per the warm design system */}
        <span lang="en" className="text-app-label text-muted-foreground uppercase">
          NexusCode
        </span>

        {/* The workspaces or the agent view — beside the brand, clear of the
            centered workspace name. */}
        <ViewToggle />
      </div>

      {/* Active workspace name — centered, editorial caption tone, and the
          menu of its tasks. SSH workspaces append "(ssh: <host>)" so the
          remote target is visible alongside the user-chosen workspace name.
          The agent view shows every workspace, so none is named. */}
      {activeWorkspace && !agentView && (
        <TaskSwitcher active={activeWorkspace} label={titleLabel} maxWidth={room} />
      )}

      {/* What follows is right-aligned. */}
      <div ref={endRef} className="ml-auto flex shrink-0 items-center">
        {/* What an update brought, until its notes are read */}
        <ReleaseNewsButton />

        {/* An update to take, while there is one */}
        <UpdateButton />

        {/* Inbox — the sessions waiting on the user */}
        <InboxButton />

        {/* Settings button — app-no-drag so click lands */}
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

/**
 * The widest the title centered in `bar` can be and stay clear of what is
 * at its start and end: a long workspace name, beside an update's buttons
 * in a narrow window, ran under them.
 */
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

/** Opens the app menu under the menu button, as a menu bar's menu opens. */
function openAppMenu(event: MouseEvent<HTMLButtonElement>): void {
  const rect = event.currentTarget.getBoundingClientRect();
  void ipcCallResult("window", "showAppMenu", { x: rect.left, y: rect.bottom });
}

function titleLabel(workspace: WorkspaceMeta): string {
  return workspaceTitleLabel(workspace.name, workspace.location);
}

/**
 * Produces the centered title-bar label. Local workspaces show just the
 * workspace name; SSH workspaces append "(ssh: <host>)" where <host> is
 * the SSH config alias when present, else "user@host", else the host alone.
 * WSL workspaces append "(wsl: <distribution>)".
 */
function workspaceTitleLabel(name: string, location: WorkspaceLocation): string {
  if (location.kind === "wsl") return `${name} (wsl: ${location.distro})`;
  if (location.kind !== "ssh") return name;
  const host =
    location.configAlias ?? (location.user ? `${location.user}@${location.host}` : location.host);
  return `${name} (ssh: ${host})`;
}
