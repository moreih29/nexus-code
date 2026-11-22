/**
 * The agent view: whether the window shows it rather than the workspaces,
 * its panels, the ended agents they show, the order of its agents and other
 * computers, and how its list groups agents and which groups are folded.
 * All persist in AppState, the panels a moment after they settle, so
 * dragging a divider writes once.
 */

import { create } from "zustand";
import { isRemoteFileKey, parseRemoteFileKey } from "../../../shared/fs/remote-file-key";
import { createLogger } from "../../../shared/log/renderer";
import type {
  AgentViewMode,
  AgentViewSnapshot,
  RemoteFileSnapshot,
} from "../../../shared/types/agent-view";
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
  isRemoteKey,
  leafShowing,
  pruneKeys,
  sanitizeLayout,
  selectHeldKey,
  showBeside,
} from "../../services/agent-view/layout";
import {
  type AgentOrder,
  NO_ORDER,
  orderFromStore,
  orderToStore,
} from "../../services/agent-view/order";
import { observeRemoteAccount, remoteAccountKey } from "../../services/remote/account";

const log = createLogger("agent-view");

/** How the list groups its agents: by their state, or by the workspace they run in. */
export type AgentListGrouping = "status" | "workspace";

export const AGENT_LIST_GROUPING_DEFAULT: AgentListGrouping = "status";

function groupingFromStore(value: string | undefined): AgentListGrouping {
  return value === "status" || value === "workspace" ? value : AGENT_LIST_GROUPING_DEFAULT;
}

const NO_FOLDS: ReadonlySet<string> = new Set();

const PERSIST_DELAY_MS = 300;

type RemoteFile = RemoteFileSnapshot & { before?: string | null };
type PeerOrder = { readonly accountKey: string; readonly ids: readonly string[] };
const NO_REMOTE_FILES: ReadonlyMap<string, RemoteFile> = new Map();

interface AgentViewState extends AgentLayout {
  mode: AgentViewMode;
  /** The agent the pointer is over in the list, whose panel lights up. */
  hoveredKey: string | null;
  /** The terminal agents the panels show ended (services/agent-view/ended), by session key. */
  ended: ReadonlyMap<string, EndedAgent>;
  remoteFiles: ReadonlyMap<string, RemoteFile>;
  /** The order the list's agents were dragged into (services/agent-view/order). */
  order: AgentOrder;
  /** The order shared by online and offline computers in the list. */
  peerOrder: PeerOrder | undefined;
  /** The current remote account, once known. */
  peerOrderAccount: string | null;
  /** How the list groups its agents. */
  grouping: AgentListGrouping;
  /** The list's groups the user folded ("status:<group>", "workspace:<id>"); the others are open. */
  folded: ReadonlySet<string>;
  /** Restores what was stored, keeping only the agents `alive` knows. */
  hydrate(snapshot: AgentViewSnapshot | undefined, alive: (key: string) => boolean): void;
  setMode(mode: AgentViewMode): void;
  toggleMode(): void;
  /** Applies a change to the panels (see services/agent-view/layout). */
  update(change: (layout: AgentLayout) => AgentLayout): void;
  placeRemoteFile(key: string, fromKey: string, file: RemoteFile): void;
  updateRemoteFile(key: string, file: Partial<RemoteFile>): void;
  setHovered(key: string | null): void;
  setEnded(ended: ReadonlyMap<string, EndedAgent>): void;
  /** The order of a workspace's (or task's) agents in the list, every one of them. */
  setOrder(workspaceId: string, keys: readonly string[]): void;
  pruneOrder(alive: (key: string) => boolean): void;
  setPeerOrderAccount(accountKey: string | null): void;
  setPeerOrder(accountKey: string, ids: readonly string[]): void;
  setGrouping(grouping: AgentListGrouping): void;
  /** Folds one of the list's groups, or opens it again. */
  toggleFolded(group: string): void;
}

const NO_ENDED: ReadonlyMap<string, EndedAgent> = new Map();

let persistTimer: ReturnType<typeof setTimeout> | undefined;
let hydrated = false;
let pending = false;
let inFlight: Promise<boolean> | undefined;

function cancelPersistTimer(): void {
  if (persistTimer !== undefined) clearTimeout(persistTimer);
  persistTimer = undefined;
}

function schedulePersist(): void {
  if (!hydrated) return;
  pending = true;
  cancelPersistTimer();
  persistTimer = setTimeout(() => void flushAgentViewPersistence(), PERSIST_DELAY_MS);
}

async function writeAgentView(): Promise<boolean> {
  pending = false;
  try {
    const { mode, root, activeLeafId, ended, remoteFiles, order, peerOrder, grouping, folded } =
      useAgentViewStore.getState();
    const agentView = {
      mode,
      root,
      activeLeafId,
      ...(ended.size > 0 ? { ended: endedToStore(ended) } : {}),
      ...(remoteFiles.size > 0
        ? {
            remoteFiles: Object.fromEntries(
              Array.from(remoteFiles, ([key, { before: _before, ...file }]) => [key, file]),
            ),
          }
        : {}),
      ...(Object.keys(order).length > 0 ? { order: orderToStore(order) } : {}),
      ...(peerOrder
        ? { peerOrder: { accountKey: peerOrder.accountKey, ids: [...peerOrder.ids] } }
        : {}),
      ...(grouping !== AGENT_LIST_GROUPING_DEFAULT ? { grouping } : {}),
      ...(folded.size > 0 ? { folded: [...folded] } : {}),
    };
    const result = await ipcCallResult("appState", "set", { agentView });
    if (result.ok) return true;
    log.warn(`appState set (agent view) failed: ${result.message}`);
  } catch (error) {
    log.warn(`appState set (agent view) failed: ${String(error)}`);
  }
  pending = true;
  return false;
}

/** Flushes the panel layout before the window closes. */
export async function flushAgentViewPersistence(): Promise<boolean> {
  cancelPersistTimer();
  while (inFlight || pending) {
    inFlight ??= writeAgentView().finally(() => {
      inFlight = undefined;
    });
    if (!(await inFlight)) return false;
    cancelPersistTimer();
  }
  return true;
}

export const useAgentViewStore = create<AgentViewState>((set, get) => ({
  mode: "workspace",
  ...emptyLayout(),
  hoveredKey: null,
  ended: NO_ENDED,
  remoteFiles: NO_REMOTE_FILES,
  order: NO_ORDER,
  peerOrder: undefined,
  peerOrderAccount: null,
  grouping: AGENT_LIST_GROUPING_DEFAULT,
  folded: NO_FOLDS,

  hydrate(snapshot, alive) {
    if (snapshot) {
      const remoteFiles = new Map(Object.entries(snapshot.remoteFiles ?? {}));
      const layout = pruneKeys(sanitizeLayout(snapshot.root, snapshot.activeLeafId), (key) => {
        if (isRemoteFileKey(key)) return remoteFiles.has(key);
        return !isRemoteKey(key) && alive(key);
      });
      const held = new Set(heldKeys(layout.root));
      set({
        mode: snapshot.mode,
        root: layout.root,
        activeLeafId: layout.activeLeafId,
        ended: endedFromStore(snapshot.ended, held),
        remoteFiles: new Map([...remoteFiles].filter(([key]) => held.has(key))),
        order: orderFromStore(snapshot.order, alive),
        peerOrder: snapshot.peerOrder,
        grouping: groupingFromStore(snapshot.grouping),
        folded: new Set(snapshot.folded ?? []),
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
    const { root, activeLeafId, remoteFiles } = get();
    const next = change({ root, activeLeafId });
    if (next.root === root && next.activeLeafId === activeLeafId) return;
    const held = remoteFiles.size > 0 && next.root !== root ? new Set(heldKeys(next.root)) : null;
    const remaining = held ? [...remoteFiles].filter(([key]) => held.has(key)) : null;
    set({
      ...next,
      ...(remaining && remaining.length !== remoteFiles.size
        ? { remoteFiles: new Map(remaining) }
        : {}),
    });
    schedulePersist();
  },

  placeRemoteFile(key, fromKey, file) {
    const { mode, root, activeLeafId, remoteFiles } = get();
    const leafId = leafShowing(root, fromKey);
    if (mode !== "agents" || leafId === null || !parseRemoteFileKey(key)) return;
    const layout = { root, activeLeafId };
    const next = selectHeldKey(layout, key) ?? showBeside(layout, key, leafId);
    set({ ...next, remoteFiles: new Map(remoteFiles).set(key, file) });
    schedulePersist();
  },

  updateRemoteFile(key, file) {
    const { remoteFiles } = get();
    const previous = remoteFiles.get(key);
    if (!previous) return;
    set({ remoteFiles: new Map(remoteFiles).set(key, { ...previous, ...file }) });
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

  setOrder(workspaceId, keys) {
    const was = get().order[workspaceId];
    if (was && was.length === keys.length && was.every((key, i) => key === keys[i])) return;
    set({ order: { ...get().order, [workspaceId]: [...keys] } });
    schedulePersist();
  },

  pruneOrder(alive) {
    const { order } = get();
    if (Object.values(order).every((keys) => keys.every(alive))) return;
    set({ order: orderFromStore(order, alive) });
    schedulePersist();
  },

  setPeerOrderAccount(accountKey) {
    const { peerOrder, peerOrderAccount } = get();
    const clear = peerOrder !== undefined && peerOrder.accountKey !== accountKey;
    if (peerOrderAccount === accountKey && !clear) return;
    set({ peerOrderAccount: accountKey, ...(clear ? { peerOrder: undefined } : {}) });
    if (clear) schedulePersist();
  },

  setPeerOrder(accountKey, ids) {
    const { peerOrder, peerOrderAccount } = get();
    if (peerOrderAccount !== accountKey) return;
    const was = peerOrder?.ids ?? [];
    if (was.length === ids.length && was.every((id, i) => id === ids[i])) return;
    set({ peerOrder: ids.length > 0 ? { accountKey, ids: [...ids] } : undefined });
    schedulePersist();
  },

  setGrouping(grouping) {
    if (get().grouping === grouping) return;
    set({ grouping });
    schedulePersist();
  },

  toggleFolded(group) {
    const next = new Set(get().folded);
    if (next.has(group)) next.delete(group);
    else next.add(group);
    set({ folded: next });
    schedulePersist();
  },
}));

/** Whether the window shows the agent view. */
export function isAgentViewShown(): boolean {
  return useAgentViewStore.getState().mode === "agents";
}

/** Clears another account's order even while the agent view is closed. */
export function startAgentViewPeerOrderSync(): () => void {
  return observeRemoteAccount((account) => {
    useAgentViewStore.getState().setPeerOrderAccount(remoteAccountKey(account));
  });
}

/** Test-only: forget the hydration, so a test starts from a fresh store. */
export function __resetAgentViewForTests(): void {
  cancelPersistTimer();
  hydrated = false;
  pending = false;
  useAgentViewStore.setState({
    mode: "workspace",
    ...emptyLayout(),
    hoveredKey: null,
    ended: NO_ENDED,
    remoteFiles: NO_REMOTE_FILES,
    order: NO_ORDER,
    peerOrder: undefined,
    peerOrderAccount: null,
    grouping: AGENT_LIST_GROUPING_DEFAULT,
    folded: NO_FOLDS,
  });
}
