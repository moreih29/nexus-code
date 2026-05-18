import { cn } from "@/utils/cn";
import type { ThemePreference } from "../../../shared/types/app-state";
import { useActiveStore } from "../../state/stores/active";
import { useThemeStore } from "../../state/stores/theme";
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
// interactive children (none today, but planned: workspace switcher, search,
// etc.) MUST opt out with the `app-no-drag` utility.
// ---------------------------------------------------------------------------

const TITLEBAR_HEIGHT_CLASS = "h-9"; // 36px — matches main/window.ts TITLEBAR_HEIGHT
const MAC_TRAFFIC_LIGHTS_INSET = 78; // px — clears the three traffic-light buttons
const WIN_OVERLAY_INSET = 140; // px — clears the Electron-rendered control overlay

// Cycle order for the theme toggle button.
const THEME_CYCLE: ThemePreference[] = ["warm-dark", "cool-dark", "warm-light", "system"];

const THEME_LABELS: Record<ThemePreference, string> = {
  "warm-dark": "WD",
  "cool-dark": "CD",
  "warm-light": "WL",
  system: "OS",
};

const THEME_TITLES: Record<ThemePreference, string> = {
  "warm-dark": "Theme: Warm Dark",
  "cool-dark": "Theme: Cool Dark",
  "warm-light": "Theme: Warm Light",
  system: "Theme: Follow OS",
};

export function TitleBar() {
  const isMac = window.host.platform === "darwin";

  const activeWorkspaceId = useActiveStore((s) => s.activeWorkspaceId);
  const activeWorkspace = useWorkspacesStore((s) =>
    activeWorkspaceId ? s.workspaces.find((w) => w.id === activeWorkspaceId) : null,
  );

  const { preference, setPreference } = useThemeStore();

  function handleThemeCycle() {
    const idx = THEME_CYCLE.indexOf(preference);
    const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
    if (next !== undefined) setPreference(next);
  }

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
      <span className="text-app-label text-muted-foreground uppercase">Nexus Code</span>

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

      {/* Theme toggle — right-aligned, app-no-drag so click lands */}
      <button
        type="button"
        onClick={handleThemeCycle}
        title={THEME_TITLES[preference]}
        className={cn(
          "app-no-drag ml-auto",
          "flex items-center justify-center",
          "w-7 h-6 rounded",
          "text-app-ui-sm text-muted-foreground",
          "hover:bg-[var(--state-hover-bg)] hover:text-foreground",
          "transition-colors duration-150",
        )}
        aria-label={THEME_TITLES[preference]}
      >
        {THEME_LABELS[preference]}
      </button>
    </div>
  );
}
