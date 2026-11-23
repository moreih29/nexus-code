import { FS_ERROR } from "../../../shared/fs/errors";
import { createLogger } from "../../../shared/log/renderer";
import { createKeyedDebouncer } from "../../../shared/util/keyed-debouncer";
import { FS_EXPANDED_SAVE_DEBOUNCE_MS } from "../../../shared/util/timing-constants";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import { relPath } from "../../utils/path";
import { getAncestors, joinPath } from "../stores/files/helpers";
import { useFilesStore } from "../stores/files/store";

function isNotFoundMessage(message: string): boolean {
  return message.startsWith(`${FS_ERROR.NOT_FOUND}:`);
}

const log = createLogger("files");

const _saveDebouncer = createKeyedDebouncer<string>({ delayMs: FS_EXPANDED_SAVE_DEBOUNCE_MS });
const _ensureRootPromises = new Map<string, Promise<void>>();
const _watchChains = new Map<string, Promise<unknown>>();
const panelWatches = new Map<string, { count: number; ready: Promise<boolean> }>();
const childLoads = new Map<string, { reload: boolean; done: Promise<void> }>();

function queueWatchCall(
  workspaceId: string,
  rel: string,
  method: "watch" | "unwatch",
  panel?: true,
): ReturnType<typeof ipcCallResult<"fs", "watch">> {
  const key = `${workspaceId}\0${rel}`;
  const previous = _watchChains.get(key);
  const send = () =>
    ipcCallResult("fs", method, { workspaceId, relPath: rel, ...(panel && { panel }) });
  const call = previous ? previous.then(send) : send();
  const tail = call.catch(() => {});
  _watchChains.set(key, tail);
  void tail.then(() => {
    if (_watchChains.get(key) === tail) _watchChains.delete(key);
  });
  return call;
}

export function retainPanelDirectoryWatch(workspaceId: string, relPath: string) {
  const key = `${workspaceId}\0${relPath}`;
  let watch = panelWatches.get(key);
  if (!watch) {
    const ready = queueWatchCall(workspaceId, relPath, "watch", true).then(
      (result) => result.ok,
      () => false,
    );
    watch = { count: 0, ready };
    panelWatches.set(key, watch);
  }
  const lease = watch;
  lease.count++;
  return {
    ready: lease.ready,
    release() {
      lease.count--;
      if (lease.count > 0) return;
      panelWatches.delete(key);
      void queueWatchCall(workspaceId, relPath, "unwatch", true).catch((error: unknown) => {
        log.warn(`unwatch panel directory failed: ${String(error)}`);
      });
    },
  };
}

function scheduleSave(workspaceId: string): void {
  _saveDebouncer.schedule(workspaceId, () => {
    const tree = useFilesStore.getState().trees.get(workspaceId);
    if (!tree) return;
    const relPaths: string[] = [];
    for (const absPath of tree.expanded) {
      if (absPath === tree.rootAbsPath) continue;
      relPaths.push(relPath(absPath, tree.rootAbsPath));
    }
    void ipcCallResult("fs", "setExpanded", { workspaceId, relPaths }).then((result) => {
      if (!result.ok) log.error(`setExpanded failed: ${result.message}`);
    });
  });
}

export async function ensureRoot(workspaceId: string, rootAbsPath: string): Promise<void> {
  const inflight = _ensureRootPromises.get(workspaceId);
  if (inflight) return inflight;

  const promise = (async () => {
    const existing = useFilesStore.getState().trees.get(workspaceId);
    if (existing) return;

    let persistedRelPaths: string[] = [];
    try {
      const result = unwrapIpcResult(await ipcCallResult("fs", "getExpanded", { workspaceId }));
      persistedRelPaths = [...new Set(result.relPaths.map((path) => path.replace(/^\/+/, "")))];
    } catch {}

    useFilesStore.getState().initTree(workspaceId, rootAbsPath, persistedRelPaths);

    void queueWatchCall(workspaceId, "", "watch").then((result) => {
      if (!result.ok) log.error(`watch root failed: ${result.message}`);
    });

    await loadChildren(workspaceId, rootAbsPath);

    const sortedRel = [...persistedRelPaths].sort((a, b) => a.length - b.length);
    const groupsByDepth = new Map<number, string[]>();
    for (const rel of sortedRel) {
      if (!rel) continue;
      const depth = rel.split("/").length;
      const existing = groupsByDepth.get(depth);
      if (existing) existing.push(rel);
      else groupsByDepth.set(depth, [rel]);
    }

    const staleRels = new Set<string>();

    const sortedDepths = Array.from(groupsByDepth.keys()).sort((a, b) => a - b);
    for (const depth of sortedDepths) {
      const group = groupsByDepth.get(depth);
      if (!group) continue;
      await Promise.all(
        group.map(async (rel) => {
          const abs = joinPath(rootAbsPath, rel);
          const node = useFilesStore.getState().trees.get(workspaceId)?.nodes.get(abs);
          if (node && node.type === "dir" && !node.childrenLoaded) {
            await loadChildren(workspaceId, abs);
          }
          const result = await queueWatchCall(workspaceId, rel, "watch");
          if (!result.ok) {
            if (isNotFoundMessage(result.message)) {
              staleRels.add(rel);
            } else {
              log.error(`watch hydrated dir failed: ${result.message}`);
            }
          }
        }),
      );
    }

    if (staleRels.size > 0) {
      const store = useFilesStore.getState();
      for (const rel of staleRels) {
        store.collapseDir(workspaceId, joinPath(rootAbsPath, rel));
      }
      const tree = useFilesStore.getState().trees.get(workspaceId);
      if (tree) {
        const remainingRels: string[] = [];
        for (const absPath of tree.expanded) {
          if (absPath === tree.rootAbsPath) continue;
          remainingRels.push(relPath(absPath, tree.rootAbsPath));
        }
        void ipcCallResult("fs", "setExpanded", {
          workspaceId,
          relPaths: remainingRels,
        }).then((res) => {
          if (!res.ok) log.error(`prune setExpanded failed: ${res.message}`);
        });
      }
    }
  })();

  _ensureRootPromises.set(workspaceId, promise);
  promise.finally(() => _ensureRootPromises.delete(workspaceId));
  return promise;
}

export async function loadChildren(workspaceId: string, absPath: string): Promise<void> {
  const tree = useFilesStore.getState().trees.get(workspaceId);
  if (!tree) return;

  const key = `${workspaceId}\0${absPath}`;
  const active = childLoads.get(key);
  if (active && tree.loading.has(absPath)) {
    active.reload = true;
    return active.done;
  }

  const completion = Promise.withResolvers<void>();
  const load = { reload: false, done: completion.promise };
  childLoads.set(key, load);
  const rel = relPath(absPath, tree.rootAbsPath);
  const ownsLoad = () => childLoads.get(key) === load;
  const listingIsStillLoading = () =>
    ownsLoad() && useFilesStore.getState().trees.get(workspaceId)?.loading.has(absPath);

  async function readUntilCurrent(): Promise<void> {
    try {
      do {
        load.reload = false;
        useFilesStore.getState().markChildrenLoading(workspaceId, absPath);
        try {
          const entries = unwrapIpcResult(
            await ipcCallResult("fs", "readdir", { workspaceId, relPath: rel }),
          );
          if (!listingIsStillLoading()) return;
          useFilesStore.getState().setChildren(workspaceId, absPath, entries);
        } catch (error) {
          if (!listingIsStillLoading()) return;
          useFilesStore
            .getState()
            .setChildrenError(
              workspaceId,
              absPath,
              error instanceof Error ? error.message : String(error),
            );
        }
      } while (load.reload && ownsLoad() && useFilesStore.getState().trees.has(workspaceId));
    } finally {
      if (ownsLoad()) childLoads.delete(key);
    }
  }

  void readUntilCurrent().then(completion.resolve, completion.reject);
  return load.done;
}

export async function toggleExpand(workspaceId: string, absPath: string): Promise<void> {
  const tree = useFilesStore.getState().trees.get(workspaceId);
  if (!tree) return;

  const node = tree.nodes.get(absPath);
  if (!node || node.type !== "dir") return;

  const isExpanded = tree.expanded.has(absPath);
  const rel = relPath(absPath, tree.rootAbsPath);

  if (isExpanded) {
    useFilesStore.getState().collapseDir(workspaceId, absPath);
    useFilesStore.getState().markChildrenStale(workspaceId, absPath);
    void queueWatchCall(workspaceId, rel, "unwatch").then((result) => {
      if (!result.ok) log.error(`unwatch failed: ${result.message}`);
    });
    scheduleSave(workspaceId);
  } else {
    useFilesStore.getState().expandDir(workspaceId, absPath);
    void queueWatchCall(workspaceId, rel, "watch").then((result) => {
      if (!result.ok) log.error(`watch failed: ${result.message}`);
    });
    scheduleSave(workspaceId);

    const currentNode = useFilesStore.getState().trees.get(workspaceId)?.nodes.get(absPath);
    if (currentNode && !currentNode.childrenLoaded) {
      await loadChildren(workspaceId, absPath);
    }
  }
}

export async function refresh(workspaceId: string, absPath?: string): Promise<void> {
  const tree = useFilesStore.getState().trees.get(workspaceId);
  if (!tree) return;

  const targetPath = absPath ?? tree.rootAbsPath;
  const node = tree.nodes.get(targetPath);
  if (!node) return;

  const expandedSnapshot = new Set(tree.expanded);

  useFilesStore.getState().wipeSubtree(workspaceId, targetPath);

  let frontier = [targetPath];
  while (frontier.length > 0) {
    await Promise.all(frontier.map((p) => loadChildren(workspaceId, p)));

    const t = useFilesStore.getState().trees.get(workspaceId);
    if (!t) break;
    const nextFrontier: string[] = [];
    for (const p of frontier) {
      const n = t.nodes.get(p);
      if (!n) continue;
      for (const child of n.children) {
        if (!expandedSnapshot.has(child)) continue;
        const childNode = t.nodes.get(child);
        if (childNode?.type === "dir") nextFrontier.push(child);
      }
    }
    frontier = nextFrontier;
  }
}

export function revealEditorActiveFile(workspaceId: string, activeFile: string): void {
  const store = useFilesStore.getState();
  const sel = store.selection.get(workspaceId);
  if (sel && sel.paths.size > 0 && sel.paths.has(activeFile)) {
    store.setFocus(workspaceId, activeFile);
  } else {
    store.setSingleSelection(workspaceId, activeFile);
  }
}

export async function collapseAll(workspaceId: string): Promise<void> {
  const tree = useFilesStore.getState().trees.get(workspaceId);
  if (!tree) return;

  const { rootAbsPath } = tree;
  const targets: string[] = [];
  for (const absPath of tree.expanded) {
    if (absPath === rootAbsPath) continue;
    targets.push(absPath);
  }
  if (targets.length === 0) return;

  const store = useFilesStore.getState();
  for (const absPath of targets) {
    store.collapseDir(workspaceId, absPath);
    store.markChildrenStale(workspaceId, absPath);
    const rel = relPath(absPath, rootAbsPath);
    void queueWatchCall(workspaceId, rel, "unwatch").then((result) => {
      if (!result.ok) log.error(`unwatch failed: ${result.message}`);
    });
  }
  scheduleSave(workspaceId);
}

export async function reveal(workspaceId: string, absPath: string): Promise<void> {
  const tree = useFilesStore.getState().trees.get(workspaceId);
  if (!tree) return;

  const ancestors = getAncestors(tree.rootAbsPath, absPath);

  for (const ancestor of ancestors) {
    const currentTree = useFilesStore.getState().trees.get(workspaceId);
    if (!currentTree) break;

    const node = currentTree.nodes.get(ancestor);
    if (!node || node.type !== "dir") continue;

    if (!currentTree.expanded.has(ancestor)) {
      useFilesStore.getState().expandDir(workspaceId, ancestor);
      void queueWatchCall(workspaceId, relPath(ancestor, currentTree.rootAbsPath), "watch").then(
        (result) => {
          if (!result.ok) log.error(`watch revealed dir failed: ${result.message}`);
        },
      );
      scheduleSave(workspaceId);
    }

    const afterExpand = useFilesStore.getState().trees.get(workspaceId);
    const afterNode = afterExpand?.nodes.get(ancestor);
    if (afterNode && !afterNode.childrenLoaded) {
      await loadChildren(workspaceId, ancestor);
    }
  }
}

export function rewatchExpandedDir(workspaceId: string, absPath: string): void {
  const tree = useFilesStore.getState().trees.get(workspaceId);
  if (!tree?.expanded.has(absPath)) return;
  void queueWatchCall(workspaceId, relPath(absPath, tree.rootAbsPath), "watch").then((result) => {
    if (!result.ok) log.error(`re-watch failed: ${result.message}`);
  });
  loadChildren(workspaceId, absPath).catch((err) => {
    log.error(`re-watch reload failed: ${(err as Error).message}`);
  });
}

export function reloadExpandedDirs(workspaceId: string): void {
  const tree = useFilesStore.getState().trees.get(workspaceId);
  if (!tree) return;
  for (const absPath of tree.expanded) {
    const node = tree.nodes.get(absPath);
    if (node?.type !== "dir" || !node.childrenLoaded) continue;
    loadChildren(workspaceId, absPath).catch((err) => {
      log.error(`resync reload failed: ${(err as Error).message}`);
    });
  }
}

export function __cancelPendingSavesForTests(): void {
  _saveDebouncer.clearAll();
}
