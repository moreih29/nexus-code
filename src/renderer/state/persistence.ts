import { createLogger } from "../../shared/log/renderer";
import type { AppState } from "../../shared/types/app-state";
import { defaultTimerScheduler, type TimerScheduler } from "../../shared/util/timer-scheduler";
import { STATE_PERSIST_DEBOUNCE_MS } from "../../shared/util/timing-constants";
import { serialize } from "../engine";
import { ipcCallResult, ipcListen } from "../ipc/client";
import { flushPendingNoteSaves } from "../services/notes/save";
import { normalizeWorkspaceTabOrder } from "./operations/tab-order";
import { flushAgentViewPersistence } from "./stores/agent-view";
import { useLayoutStore } from "./stores/layout";
import { restoredTitles, useTabsStore } from "./stores/tabs";

export { STATE_PERSIST_DEBOUNCE_MS };

const log = createLogger("persistence");

type LayoutSnapshot = NonNullable<AppState["layoutByWorkspace"]>[string];

function toSnapshot(workspaceId: string): LayoutSnapshot | null {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  const tabRecord = useTabsStore.getState().byWorkspace[workspaceId] ?? {};

  if (!layout) return null;

  const tabs = Object.values(tabRecord).filter(
    (t) => t.type !== "untitled",
  ) as LayoutSnapshot["tabs"];
  return {
    root: serialize(layout.root),
    activeGroupId: layout.activeGroupId,
    tabs,
  };
}

export function hydrateLayoutSnapshots(snapshots: AppState["layoutByWorkspace"]): void {
  if (snapshots) {
    for (const [wsId, snap] of Object.entries(snapshots)) {
      try {
        const tabsMap: Record<
          string,
          (typeof snap.tabs)[number] & {
            isPreview: boolean;
            isPinned: boolean;
            defaultTitle: string;
          }
        > = {};
        for (const t of snap.tabs) {
          const isPreview =
            "isPreview" in t && typeof t.isPreview === "boolean" ? t.isPreview : false;
          const isPinned = "isPinned" in t && typeof t.isPinned === "boolean" ? t.isPinned : false;
          tabsMap[t.id] = { ...t, isPreview, isPinned, ...restoredTitles(t) };
        }
        useTabsStore.setState((s) => ({
          byWorkspace: { ...s.byWorkspace, [wsId]: tabsMap },
        }));

        const knownTabIds = new Set(snap.tabs.map((t) => t.id));
        useLayoutStore
          .getState()
          .hydrate(wsId, { root: snap.root, activeGroupId: snap.activeGroupId }, knownTabIds);
        normalizeWorkspaceTabOrder(wsId);
      } catch {}
    }
  }
}

let persistence: { flush(): Promise<boolean>; stop(): void } | undefined;

export function registerStatePersistence(scheduler: TimerScheduler = defaultTimerScheduler): void {
  if (persistence) return;
  const pending = new Set<string>();
  let timer: unknown;
  let stopped = false;
  let inFlight: Promise<boolean> | undefined;

  function cancelTimer(): void {
    if (timer === undefined) return;
    scheduler.clearTimeout(timer);
    timer = undefined;
  }

  async function write(): Promise<boolean> {
    const workspaceIds = [...pending];
    pending.clear();
    const layoutByWorkspace: NonNullable<AppState["layoutByWorkspace"]> = {};
    for (const id of workspaceIds) {
      const snapshot = toSnapshot(id);
      if (snapshot) layoutByWorkspace[id] = snapshot;
    }
    if (Object.keys(layoutByWorkspace).length === 0) return true;

    try {
      const result = await ipcCallResult("appState", "set", { layoutByWorkspace });
      if (result.ok) return true;
      log.warn(`Layout save failed: ${result.message}`);
    } catch (error) {
      log.warn(`Layout save failed: ${String(error)}`);
    }
    if (!stopped) for (const id of workspaceIds) pending.add(id);
    return false;
  }

  async function flush(): Promise<boolean> {
    cancelTimer();
    while (!stopped && (inFlight || pending.size > 0)) {
      inFlight ??= write().finally(() => {
        inFlight = undefined;
      });
      if (!(await inFlight)) return false;
      cancelTimer();
    }
    return true;
  }

  function recordChanges(next: Record<string, unknown>, previous: Record<string, unknown>): void {
    if (next === previous) return;
    const ids = new Set([...Object.keys(next), ...Object.keys(previous)]);
    for (const id of ids) {
      if (next[id] !== previous[id]) pending.add(id);
    }
    if (pending.size === 0) return;

    cancelTimer();
    timer = scheduler.setTimeout(() => {
      timer = undefined;
      void flush();
    }, STATE_PERSIST_DEBOUNCE_MS);
  }

  const unsubLayout = useLayoutStore.subscribe((state, previous) =>
    recordChanges(state.byWorkspace, previous.byWorkspace),
  );
  const unsubTabs = useTabsStore.subscribe((state, previous) =>
    recordChanges(state.byWorkspace, previous.byWorkspace),
  );
  persistence = {
    flush,
    stop() {
      stopped = true;
      cancelTimer();
      unsubLayout();
      unsubTabs();
      pending.clear();
    },
  };
}

export function unregisterStatePersistence(): void {
  persistence?.stop();
  persistence = undefined;
}

export function flushStatePersistence(): Promise<boolean> {
  return persistence?.flush() ?? Promise.resolve(true);
}

export function installLayoutClosePersistence(): () => void {
  return ipcListen("window", "prepareClose", ({ attempt }) => {
    void (async () => {
      const results = await Promise.all([
        flushStatePersistence(),
        flushAgentViewPersistence(),
        flushPendingNoteSaves(),
      ]);
      const saved = results.every(Boolean);
      const result = await ipcCallResult("window", "closePrepared", { attempt, saved });
      if (!result.ok) log.warn(`Could not acknowledge window flush: ${result.message}`);
    })().catch((error: unknown) => {
      log.warn(`Could not complete window flush: ${String(error)}`);
    });
  });
}
