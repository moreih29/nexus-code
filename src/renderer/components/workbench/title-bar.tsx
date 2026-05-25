import { Settings } from "lucide-react";
import { cn } from "@/utils/cn";
import type { WorkspaceLocation } from "../../../shared/types/workspace";
import { useActiveStore } from "../../state/stores/active";
import { useSettingsUIStore } from "../../state/stores/settings-ui";
import { useWorkspacesStore } from "../../state/stores/workspaces";

// ---------------------------------------------------------------------------
// TitleBar — custom frameless titlebar
//
// Native chrome configuration (see src/main/window.ts):
//   - macOS:    `titleBarStyle: "hiddenInset"` keeps the traffic lights at
//               top-left. We pad the bar's left edge to clear them.
//   - Win/Linux: `titleBarOverlay` renders themed min/max/close at top-right.
//               We pad the bar's right edge to clear that overlay.
//
// Drag region is applied via the `app-drag` utility (see globals.css);
// interactive children MUST opt out with the `app-no-drag` utility.
// ---------------------------------------------------------------------------

const TITLEBAR_HEIGHT_CLASS = "h-9"; // 36px — matches main/window.ts TITLEBAR_HEIGHT
const MAC_TRAFFIC_LIGHTS_INSET = 78; // px — clears the three traffic-light buttons
const WIN_OVERLAY_INSET = 140; // px — clears the Electron-rendered control overlay

export function TitleBar() {
  const isMac = window.host.platform === "darwin";

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
        paddingLeft: isMac ? MAC_TRAFFIC_LIGHTS_INSET : 12,
        paddingRight: isMac ? 12 : WIN_OVERLAY_INSET,
      }}
    >
      {/* Brand — uppercase small-label per the warm design system */}
      <span className="text-app-label text-muted-foreground uppercase">NexusCode</span>

      {/* Active workspace name — centered, editorial caption tone.
          SSH workspaces append "(ssh: <host>)" so the remote target is
          visible alongside the user-chosen workspace name. */}
      {activeWorkspace && (
        <span
          className={cn(
            "absolute left-1/2 -translate-x-1/2",
            "text-app-body-emphasis text-foreground truncate max-w-[40%]",
          )}
          title={workspaceTitleLabel(activeWorkspace.name, activeWorkspace.location)}
        >
          {workspaceTitleLabel(activeWorkspace.name, activeWorkspace.location)}
        </span>
      )}

      {/* Settings button — right-aligned, app-no-drag so click lands */}
      <button
        type="button"
        onClick={toggleSettings}
        aria-label="Open settings"
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
    </div>
  );
}

/**
 * Produces the centered title-bar label. Local workspaces show just the
 * workspace name; SSH workspaces append "(ssh: <host>)" where <host> is
 * the SSH config alias when present, else "user@host", else the host alone.
 */
function workspaceTitleLabel(name: string, location: WorkspaceLocation): string {
  if (location.kind !== "ssh") return name;
  const host =
    location.configAlias ?? (location.user ? `${location.user}@${location.host}` : location.host);
  return `${name} (ssh: ${host})`;
}
