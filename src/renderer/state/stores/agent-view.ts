/**
 * The agent view: whether the window shows it rather than the workspaces,
 * its panels, and the ended agents they show. All persist in AppState, the
 * panels a moment after they settle, so dragging a divider writes once.
 */

import { create } from "zustand";
import { createLogger } from "../../../shared/log/renderer";
import type { AgentViewMode, AgentViewSnapshot } from "../../../shared/types/agent-view";
import { ipcCallResult } from "../../ipc/client";
import {
  type EndedAgent,
  endedFromStore,
  endedToStore,
  sameEnded,
} from "../../services/agent-view/ended";
import {
  type AgentLayout,
  emptyLayout,
  heldKeys,
  pruneKeys,
  sanitizeLayout,
} from "../../services/agent-view/layout";

const log = createLogger("agent-view");

const PERSIST_DELAY_MS = 300;

interface AgentViewState extends AgentLayout {
  mode: AgentViewMode;
  /** The agent the pointer is over in the list, whose panel lights up. */
  hoveredKey: string | null;
  /** The terminal agents the panels show ended (services/agent-view/ended), by session key. */
  ended: ReadonlyMap<string, EndedAgent>;
  /** Restores what was stored, keeping only the agents `alive` knows. */
  hydrate(snapshot: AgentViewSnapshot | undefined, alive: (key: string) => boolean): void;
  setMode(mode: AgentViewMode): void;
  toggleMode(): void;
  /** Applies a change to the panels (see services/agent-view/layout). */
  update(change: (layout: AgentLayout) => AgentLayout): void;
  setHovered(key: string | null): void;
  setEnded(ended: ReadonlyMap<string, EndedAgent>): void;
}

const NO_ENDED: ReadonlyMap<string, EndedAgent> = new Map();

let persistTimer: ReturnType<typeof setTimeout> | undefined;
let hydrated = false;

function schedulePersist(): void {
  if (!hydrated) return;
  if (persistTimer !== undefined) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    const { mode, root, activeLeafId, ended } = useAgentViewStore.getState();
    const agentView = {
      mode,
      root,
      activeLeafId,
      ...(ended.size > 0 ? { ended: endedToStore(ended) } : {}),
    };
    void ipcCallResult("appState", "set", { agentView }).then((result) => {
      if (!result.ok) log.warn(`appState set (agent view) failed: ${result.message}`);
    });
  }, PERSIST_DELAY_MS);
}

export const useAgentViewStore = create<AgentViewState>((set, get) => ({
  mode: "workspace",
  ...emptyLayout(),
  hoveredKey: null,
  ended: NO_ENDED,

  hydrate(snapshot, alive) {
    if (snapshot) {
      const layout = pruneKeys(sanitizeLayout(snapshot.root, snapshot.activeLeafId), alive);
      set({
        mode: snapshot.mode,
        root: layout.root,
        activeLeafId: layout.activeLeafId,
        ended: endedFromStore(snapshot.ended, new Set(heldKeys(layout.root))),
      });
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

  setEnded(ended) {
    if (sameEnded(get().ended, ended)) return;
    set({ ended });
    schedulePersist();
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
  useAgentViewStore.setState({
    mode: "workspace",
    ...emptyLayout(),
    hoveredKey: null,
    ended: NO_ENDED,
  });
}
