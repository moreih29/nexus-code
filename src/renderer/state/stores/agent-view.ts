import { create } from "zustand";
import { isRemoteFileKey, parseRemoteFileKey } from "../../../shared/fs/remote-file-key";
import { createLogger } from "../../../shared/log/renderer";
import {
  type AgentViewMode,
  type AgentViewSnapshot,
  MAX_REMOTE_SEEN,
  normalizeAgentViewFolds,
  type RemoteFileSnapshot,
  type RemoteSeenResult,
} from "../../../shared/types/agent-view";
import { serialize } from "../../engine";
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

export type AgentListGrouping = "status" | "workspace";

export const AGENT_LIST_GROUPING_DEFAULT: AgentListGrouping = "status";

function groupingFromStore(value: string | undefined): AgentListGrouping {
  return value === "status" || value === "workspace" ? value : AGENT_LIST_GROUPING_DEFAULT;
}

const NO_FOLDS: ReadonlySet<string> = new Set();

const PERSIST_DELAY_MS = 300;

type RemoteFile = RemoteFileSnapshot & { before?: string | null };
type PeerOrder = { readonly accountKey: string; readonly ids: readonly string[] };
type RemoteSeen = { accountKey: string; entries: ReadonlyMap<string, RemoteSeenResult> };
const NO_REMOTE_FILES: ReadonlyMap<string, RemoteFile> = new Map();

interface AgentViewState extends AgentLayout {
  mode: AgentViewMode;
  hoveredKey: string | null;
  ended: ReadonlyMap<string, EndedAgent>;
  remoteFiles: ReadonlyMap<string, RemoteFile>;
  order: AgentOrder;
  peerOrder: PeerOrder | undefined;
  peerOrderAccount: string | null;
  grouping: AgentListGrouping;
  folded: ReadonlySet<string>;
  remoteSeen: RemoteSeen | undefined;
  updateRemoteSeen(accountKey: string, changes: ReadonlyMap<string, RemoteSeenResult | null>): void;
  hydrate(snapshot: AgentViewSnapshot | undefined, alive: (key: string) => boolean): void;
  setMode(mode: AgentViewMode): void;
  toggleMode(): void;
  update(change: (layout: AgentLayout) => AgentLayout): void;
  placeRemoteFile(key: string, fromKey: string, file: RemoteFile): void;
  updateRemoteFile(key: string, file: Partial<RemoteFile>): void;
  setHovered(key: string | null): void;
  setEnded(ended: ReadonlyMap<string, EndedAgent>): void;
  setOrder(workspaceId: string, keys: readonly string[]): void;
  pruneOrder(alive: (key: string) => boolean): void;
  setPeerOrderAccount(accountKey: string | null): void;
  setPeerOrder(accountKey: string, ids: readonly string[]): void;
  setGrouping(grouping: AgentListGrouping): void;
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
    const {
      mode,
      root,
      activeLeafId,
      ended,
      remoteFiles,
      order,
      peerOrder,
      grouping,
      folded,
      remoteSeen,
    } = useAgentViewStore.getState();
    const agentView = {
      mode,
      root: serialize(root),
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
      ...(remoteSeen
        ? { remoteSeen: { accountKey: remoteSeen.accountKey, entries: [...remoteSeen.entries] } }
        : {}),
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
  remoteSeen: undefined,

  hydrate(snapshot, alive) {
    if (snapshot) {
      const remoteSeen = snapshot.remoteSeen;
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
        folded: new Set(normalizeAgentViewFolds(snapshot.folded ?? [])),
        remoteSeen: remoteSeen && {
          accountKey: remoteSeen.accountKey,
          entries: new Map(remoteSeen.entries),
        },
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
    const [key] = normalizeAgentViewFolds([group]);
    if (key === undefined) return;
    const next = new Set(get().folded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    set({ folded: new Set(normalizeAgentViewFolds(next)) });
    schedulePersist();
  },

  updateRemoteSeen(accountKey, changes) {
    const view = get();
    if (view.peerOrderAccount !== null && view.peerOrderAccount !== accountKey) return;
    const saved = view.remoteSeen?.accountKey === accountKey ? view.remoteSeen.entries : undefined;
    const entries = new Map(saved);
    let changed = false;
    for (const [key, value] of changes) {
      if (!isRemoteKey(key) || key.length > 200) continue;
      if (value === null) {
        changed = entries.delete(key) || changed;
        continue;
      }
      if (
        !Number.isFinite(value.at) ||
        (value.listedAt != null && !Number.isFinite(value.listedAt))
      )
        continue;
      const before = entries.get(key);
      if (
        before?.at === value.at &&
        before.undated === value.undated &&
        before.listedAt === value.listedAt
      )
        continue;
      entries.delete(key);
      entries.set(key, value);
      changed = true;
    }
    if (!changed) return;
    for (const key of entries.keys()) {
      if (entries.size <= MAX_REMOTE_SEEN) break;
      entries.delete(key);
    }
    set({ remoteSeen: entries.size > 0 ? { accountKey, entries } : undefined });
    schedulePersist();
  },
}));

export function isAgentViewShown(): boolean {
  return useAgentViewStore.getState().mode === "agents";
}

export function startAgentViewPeerOrderSync(): () => void {
  return observeRemoteAccount((account) => {
    useAgentViewStore.getState().setPeerOrderAccount(remoteAccountKey(account));
  });
}

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
    remoteSeen: undefined,
  });
}
