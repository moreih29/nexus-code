import { Menu, Settings } from "lucide-react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { ipcCallResult } from "../../ipc/client";
import type { WorkspaceLocation, WorkspaceMeta } from "../../../shared/types/workspace";
import { useActiveStore } from "../../state/stores/active";
import { useSettingsUIStore } from "../../state/stores/settings-ui";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { isMac } from "../../utils/platform";
import { TaskSwitcher } from "./task-switcher";
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

export function TitleBar() {
  const { t } = useTranslation();
  const ownControls = window.host.transparentWindow === true;

  const activeWorkspaceId = useActiveStore((s) => s.activeWorkspaceId);
  const activeWorkspace = useWorkspacesStore((s) =>
    activeWorkspaceId ? s.workspaces.find((w) => w.id === activeWorkspaceId) : null,
  );

  const settingsOpen = useSettingsUIStore((s) => s.settingsOpen);
  const toggleSettings = useSettingsUIStore((s) => s.toggleSettings);

  return (
    <div
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
      {!isMac() && (
        <button
          type="button"
          onClick={openAppMenu}
          // Focus stays where it was, so Edit's items act on the editor or
          // input the user was in.
          onMouseDown={(e) => e.preventDefault()}
          aria-label={t("titleBar.open_menu")}
          aria-haspopup="menu"
          className={cn(
            "app-no-drag -ml-1.5 mr-1.5",
            "flex items-center justify-center",
            "size-7 rounded-(--radius-control)",
            "text-muted-foreground",
            "hover:bg-[var(--state-hover-bg)] hover:text-foreground",
            "transition-colors duration-150",
          )}
        >
          <Menu className="size-4" aria-hidden="true" />
        </button>
      )}

      {/* Brand — uppercase small-label per the warm design system */}
      <span className="text-app-label text-muted-foreground uppercase">NexusCode</span>

      {/* Active workspace name — centered, editorial caption tone, and the
          menu of its tasks. SSH workspaces append "(ssh: <host>)" so the
          remote target is visible alongside the user-chosen workspace name. */}
      {activeWorkspace && <TaskSwitcher active={activeWorkspace} label={titleLabel} />}

      {/* Settings button — right-aligned, app-no-drag so click lands */}
      <button
        type="button"
        onClick={toggleSettings}
        aria-label={t("titleBar.open_settings")}
        aria-haspopup="dialog"
        aria-expanded={settingsOpen}
        className={cn(
          "app-no-drag ml-auto",
          "flex items-center justify-center",
          "size-7 rounded-(--radius-control)",
          "text-muted-foreground",
          "hover:bg-[var(--state-hover-bg)] hover:text-foreground",
          settingsOpen && "bg-[var(--state-selected-bg)] text-foreground",
          "transition-colors duration-150",
        )}
      >
        <Settings className="size-4" aria-hidden="true" />
      </button>

      {ownControls && <WindowControls />}
    </div>
  );
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
