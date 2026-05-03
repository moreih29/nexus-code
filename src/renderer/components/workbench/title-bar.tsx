import { cn } from "@/utils/cn";
import { useActiveStore } from "../../store/active";
import { useWorkspacesStore } from "../../store/workspaces";

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
// interactive children (none today, but planned: workspace switcher, search,
// etc.) MUST opt out with the `app-no-drag` utility.
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

  return (
    <div
      role="presentation"
      className={cn(
        // bg-muted matches the sidebar so chrome reads as one continuous
        // L-shape against the canvas; no border — depth via tone shift only
        // (per design.md "depth comes from opacity shifts, not heavy lines").
        "relative flex shrink-0 items-center bg-muted select-none app-drag",
        TITLEBAR_HEIGHT_CLASS,
      )}
      style={{
        paddingLeft: isMac ? MAC_TRAFFIC_LIGHTS_INSET : 12,
        paddingRight: isMac ? 12 : WIN_OVERLAY_INSET,
      }}
    >
      {/* Brand — uppercase small-label per the warm design system */}
      <span className="text-small-label text-muted-foreground uppercase">Nexus Code</span>

      {/* Active workspace name — centered, editorial caption tone */}
      {activeWorkspace && (
        <span
          className={cn(
            "absolute left-1/2 -translate-x-1/2",
            "text-app-body-emphasis text-foreground truncate max-w-[40%]",
          )}
        >
          {activeWorkspace.name}
        </span>
      )}
    </div>
  );
}
