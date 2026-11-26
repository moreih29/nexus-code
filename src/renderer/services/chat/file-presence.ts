import { useEffect, useState } from "react";
import { ipcCallResult } from "@/ipc/client";
import {
  isAbsoluteOutsidePath,
  isAutoMountPath,
  isDevicePath,
  isDrivePath,
  isNetworkOrDevicePath,
} from "../../../shared/fs/outside-url";
import { isUnder } from "../../../shared/fs/relative-path";
import { useChatFiles } from "./chat-files";

const FRESH_MS = 30_000;

export type FileLookup = (workspaceId: string, relPath: string) => Promise<boolean>;

const lookUpInWorkspace: FileLookup = async (workspaceId, relPath) => {
  if (isAbsoluteOutsidePath(relPath)) {
    const there = await ipcCallResult("fs", "outsideExists", {
      workspaceId,
      absolutePath: relPath,
    }).catch(() => null);
    return there?.ok === true && there.value;
  }
  const stat = await ipcCallResult("fs", "stat", { workspaceId, relPath }).catch(() => null);
  return stat?.ok === true && stat.value.type !== "dir";
};

export function lookupPath(path: string, root: string): string | null {
  if (!root || !isUnder(path, root)) return null;
  const base = root.replace(/[\\/]+$/, "");
  return path.length > base.length ? path.slice(base.length + 1) : null;
}

function outsidePathToLookUp(path: string, root: string): string | null {
  if (isNetworkOrDevicePath(path)) return null;
  if (!root || !isAbsoluteOutsidePath(path) || isUnder(path, root)) return null;
  if ((isDrivePath(root) || isNetworkOrDevicePath(root)) && !isDrivePath(path)) return null;
  return path;
}

export function pathToLookUp(path: string, root: string): string | null {
  if (isDevicePath(path)) return null;
  const relPath = lookupPath(path, root);
  if (relPath !== null) return relPath;
  const outside = outsidePathToLookUp(path, root);
  return outside !== null && !isAutoMountPath(outside) ? outside : null;
}

export function isUnknownFile(path: string, root: string): boolean {
  return (
    !isDevicePath(path) &&
    lookupPath(path, root) === null &&
    outsidePathToLookUp(path, root) !== null &&
    isAutoMountPath(path)
  );
}

export function createFilePresence(
  lookUp: FileLookup = lookUpInWorkspace,
  now: () => number = Date.now,
) {
  const found = new Map<string, number>();
  const asking = new Map<string, Promise<boolean>>();
  return {
    known(workspaceId: string, path: string): true | undefined {
      const at = found.get(`${workspaceId}\u0000${path}`);
      return at !== undefined && now() - at < FRESH_MS ? true : undefined;
    },
    async isThere(workspaceId: string, root: string, path: string): Promise<boolean> {
      const key = `${workspaceId}\u0000${path}`;
      const fresh = this.known(workspaceId, path);
      if (fresh !== undefined) return fresh;
      const relPath = pathToLookUp(path, root);
      if (relPath === null) return false;
      let pending = asking.get(key);
      if (!pending) {
        pending = lookUp(workspaceId, relPath)
          .catch(() => false)
          .then((there) => {
            if (there) found.set(key, now());
            else found.delete(key);
            asking.delete(key);
            return there;
          });
        asking.set(key, pending);
      }
      return pending;
    },
  };
}

const MAX_LOOKUPS = 32;

export async function filesFound(
  presence: Pick<ReturnType<typeof createFilePresence>, "isThere">,
  workspaceId: string,
  root: string,
  paths: readonly string[],
  max = MAX_LOOKUPS,
): Promise<ReadonlySet<string>> {
  const found = new Set<string>();
  let next = 0;
  const lookUpNext = async () => {
    while (next < paths.length) {
      const path = paths[next++];
      if (await presence.isThere(workspaceId, root, path)) found.add(path);
    }
  };
  await Promise.all(Array.from({ length: Math.min(max, paths.length) }, lookUpNext));
  return new Set(paths.filter((path) => found.has(path)));
}

export async function filesGone(
  presence: Pick<ReturnType<typeof createFilePresence>, "isThere">,
  workspaceId: string,
  root: string,
  paths: readonly string[],
): Promise<ReadonlySet<string>> {
  const looked = paths.filter((path) => pathToLookUp(path, root) !== null);
  const found = await filesFound(presence, workspaceId, root, looked);
  return new Set(looked.filter((path) => !found.has(path)));
}

const presence = createFilePresence();
const EMPTY_PATHS: ReadonlySet<string> = new Set();

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...b].every((path) => a.has(path));
}

export function filesThere(
  workspaceId: string,
  root: string,
  paths: readonly string[],
): Promise<ReadonlySet<string>> {
  return filesFound(presence, workspaceId, root, paths);
}

export function useFoundFiles(
  workspaceId: string,
  root: string,
  paths: readonly string[],
  recheck: unknown = null,
): ReadonlySet<string> {
  const key = paths.join("\n");
  const files = useChatFiles();
  const scope = files ? (files.access?.scope ?? null) : undefined;
  const [found, setFound] = useState<{ scope: typeof scope; paths: ReadonlySet<string> }>(() => ({
    scope,
    paths: files ? EMPTY_PATHS : new Set(paths.filter((path) => presence.known(workspaceId, path))),
  }));
  if (found.scope !== scope) setFound({ scope, paths: EMPTY_PATHS });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `recheck` only says when to look again
  useEffect(() => {
    const signal = files?.access?.signal;
    if (files && (!signal || signal.aborted)) return;
    let live = true;
    const wanted = key === "" ? [] : key.split("\n");
    const looked = files ? files.there(wanted) : filesThere(workspaceId, root, wanted);
    void looked.then((next) => {
      if (!live || signal?.aborted) return;
      setFound((was) =>
        was.scope !== scope ||
        (was.paths.size === next.size && [...next].every((path) => was.paths.has(path)))
          ? was
          : { scope, paths: next },
      );
    });
    return () => {
      live = false;
    };
  }, [workspaceId, root, key, recheck, files, scope]);
  return found.scope === scope ? found.paths : EMPTY_PATHS;
}

export function useGoneFiles(
  workspaceId: string,
  root: string,
  paths: readonly string[],
): ReadonlySet<string> {
  const key = paths.join("\n");
  const [gone, setGone] = useState<ReadonlySet<string>>(EMPTY_PATHS);
  useEffect(() => {
    let live = true;
    const wanted = key === "" ? [] : key.split("\n");
    void filesGone(presence, workspaceId, root, wanted).then((next) => {
      if (live) setGone((was) => (sameSet(was, next) ? was : next));
    });
    return () => {
      live = false;
    };
  }, [workspaceId, root, key]);
  return gone;
}
