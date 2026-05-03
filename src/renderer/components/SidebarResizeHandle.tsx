import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  useUIStore,
} from "../store/ui";
import { ResizeHandle } from "./ResizeHandle";

// ---------------------------------------------------------------------------
// Thin adapter — wires the generic ResizeHandle to the sidebarWidth slice.
// All drag math / event wiring lives in <ResizeHandle/>.
// ---------------------------------------------------------------------------

export function SidebarResizeHandle() {
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);

  return (
    <ResizeHandle
      value={sidebarWidth}
      min={SIDEBAR_WIDTH_MIN}
      max={SIDEBAR_WIDTH_MAX}
      ariaLabel="Resize sidebar"
      placement="rightInside"
      onResize={(width, persist) => useUIStore.getState().setSidebarWidth(width, persist)}
      onReset={() => useUIStore.getState().setSidebarWidth(SIDEBAR_WIDTH_DEFAULT, true)}
    />
  );
}
