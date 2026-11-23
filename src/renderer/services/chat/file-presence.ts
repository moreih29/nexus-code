import { useEffect, useState } from "react";
import { ipcCallResult } from "@/ipc/client";
import { isAbsoluteOutsidePath } from "../../../shared/fs/outside-url";
import { isUnder } from "../../../shared/fs/relative-path";
import { isOutsideGranted, useOutsideGrantsStore } from "../../state/stores/outside-grants";
import { useChatFiles } from "./chat-files";

const FRESH_MS = 30_000;

export type FileLookup = (workspaceId: string, relPath: string) => Promise<boolean>;

export type OutsideGrantCheck = (workspaceId: string, path: string) => boolean;

const lookUpInWorkspace: FileLookup = async (workspaceId, relPath) => {
  if (isAbsoluteOutsidePath(relPath)) {
    const read = await ipcCallResult("fs", "readRange", {
      workspaceId,
      relPath,
      offset: 0,
      length: 0,
    }).catch(() => null);
    return read?.ok === true && read.value.kind !== "missing";
  }
  const stat = await ipcCallResult("fs", "stat", { workspaceId, relPath }).catch(() => null);
  return stat?.ok === true && stat.value.type !== "dir";
};

const grantedOutside: OutsideGrantCheck = (workspaceId, path) =>
  isOutsideGranted(useOutsideGrantsStore.getState().byWorkspace, workspaceId, path);

export function lookupPath(path: string, root: string): string | null {
  if (!root || !isUnder(path, root)) return null;
  const base = root.replace(/[\\/]+$/, "");
  return path.length > base.length ? path.slice(base.length + 1) : null;
}

function pathToLookUp(
  workspaceId: string,
  path: string,
  root: string,
  granted: OutsideGrantCheck,
): string | null {
  const relPath = lookupPath(path, root);
  if (relPath !== null) return relPath;
  if (!root || !isAbsoluteOutsidePath(path) || isUnder(path, root)) return null;
  return granted(workspaceId, path) ? path : null;
}

export function createFilePresence(
  lookUp: FileLookup = lookUpInWorkspace,
  now: () => number = Date.now,
  granted: OutsideGrantCheck = grantedOutside,
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
      const relPath = pathToLookUp(workspaceId, path, root, granted);
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
  granted: OutsideGrantCheck = grantedOutside,
): Promise<ReadonlySet<string>> {
  const looked = paths.filter((path) => pathToLookUp(workspaceId, path, root, granted) !== null);
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
  const outside = useOutsideGrantsStore((s) =>
    paths.filter((path) => isOutsideGranted(s.byWorkspace, workspaceId, path)).join("\n"),
  );
  const files = useChatFiles();
  const scope = files ? (files.access?.scope ?? null) : undefined;
  const [found, setFound] = useState<{ scope: typeof scope; paths: ReadonlySet<string> }>(() => ({
    scope,
    paths: files ? EMPTY_PATHS : new Set(paths.filter((path) => presence.known(workspaceId, path))),
  }));
  if (found.scope !== scope) setFound({ scope, paths: EMPTY_PATHS });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `recheck` and `outside` only say when to look again
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
  }, [workspaceId, root, key, recheck, outside, files, scope]);
  return found.scope === scope ? found.paths : EMPTY_PATHS;
}

export function useGoneFiles(
  workspaceId: string,
  root: string,
  paths: readonly string[],
): ReadonlySet<string> {
  const key = paths.join("\n");
  const outside = useOutsideGrantsStore((s) =>
    paths.filter((path) => isOutsideGranted(s.byWorkspace, workspaceId, path)).join("\n"),
  );
  const [gone, setGone] = useState<ReadonlySet<string>>(EMPTY_PATHS);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `outside` only says when to look again
  useEffect(() => {
    let live = true;
    const wanted = key === "" ? [] : key.split("\n");
    void filesGone(presence, workspaceId, root, wanted).then((next) => {
      if (live) setGone((was) => (sameSet(was, next) ? was : next));
    });
    return () => {
      live = false;
    };
  }, [workspaceId, root, key, outside]);
  return gone;
}
