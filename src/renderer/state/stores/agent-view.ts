/**
 * The agent view: whether the window shows it rather than the workspaces,
 * and its panels. Both persist in AppState, the panels a moment after they
 * settle, so dragging a divider writes once.
 */

import { create } from "zustand";
import { createLogger } from "../../../shared/log/renderer";
import type { AgentViewMode, AgentViewSnapshot } from "../../../shared/types/agent-view";
import { ipcCallResult } from "../../ipc/client";
import {
  type AgentLayout,
  emptyLayout,
  pruneKeys,
  sanitizeLayout,
} from "../../services/agent-view/layout";

const log = createLogger("agent-view");

const PERSIST_DELAY_MS = 300;

interface AgentViewState extends AgentLayout {
  mode: AgentViewMode;
  /** The agent the pointer is over in the list, whose panel lights up. */
  hoveredKey: string | null;
  /** Restores what was stored, keeping only the agents `alive` knows. */
  hydrate(snapshot: AgentViewSnapshot | undefined, alive: (key: string) => boolean): void;
  setMode(mode: AgentViewMode): void;
  toggleMode(): void;
  /** Applies a change to the panels (see services/agent-view/layout). */
  update(change: (layout: AgentLayout) => AgentLayout): void;
  setHovered(key: string | null): void;
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;
let hydrated = false;

function schedulePersist(): void {
  if (!hydrated) return;
  if (persistTimer !== undefined) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    const { mode, root, activeLeafId } = useAgentViewStore.getState();
    void ipcCallResult("appState", "set", { agentView: { mode, root, activeLeafId } }).then(
      (result) => {
        if (!result.ok) log.warn(`appState set (agent view) failed: ${result.message}`);
      },
    );
  }, PERSIST_DELAY_MS);
}

export const useAgentViewStore = create<AgentViewState>((set, get) => ({
  mode: "workspace",
  ...emptyLayout(),
  hoveredKey: null,

  hydrate(snapshot, alive) {
    if (snapshot) {
      const layout = pruneKeys(sanitizeLayout(snapshot.root, snapshot.activeLeafId), alive);
      set({ mode: snapshot.mode, root: layout.root, activeLeafId: layout.activeLeafId });
    }
    hydrated = true;
  },

  setMode(mode) {
    if (get().mode === mode) return;
    set({ mode, hoveredKey: null });
    schedulePersist();
  },

  toggleMode() {
    get().setMode(get().mode === "agents" ? "workspace" : "agents");
  },

  update(change) {
    const { root, activeLeafId } = get();
    const next = change({ root, activeLeafId });
    if (next.root === root && next.activeLeafId === activeLeafId) return;
    set({ root: next.root, activeLeafId: next.activeLeafId });
    schedulePersist();
  },

  setHovered(key) {
    if (get().hoveredKey !== key) set({ hoveredKey: key });
  },
}));

/** Whether the window shows the agent view. */
export function isAgentViewShown(): boolean {
  return useAgentViewStore.getState().mode === "agents";
}

/** Test-only: forget the hydration, so a test starts from a fresh store. */
export function __resetAgentViewForTests(): void {
  if (persistTimer !== undefined) clearTimeout(persistTimer);
  persistTimer = undefined;
  hydrated = false;
  useAgentViewStore.setState({ mode: "workspace", ...emptyLayout(), hoveredKey: null });
}
