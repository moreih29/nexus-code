/**
 * Whether the files a session names are there. A reply may name a path
 * that is gone, a folder (`/dev/shm`), or a file on another machine, so a
 * chat shows a file only once it is found: in its workspace, or outside it
 * where a tab of the workspace granted the previews that file.
 */

import { useEffect, useState } from "react";
import { ipcCallResult } from "@/ipc/client";
import { isAbsoluteOutsidePath } from "../../../shared/fs/outside-url";
import { isOutsideGranted, useOutsideGrantsStore } from "../../state/stores/outside-grants";
import { useChatFiles } from "./chat-files";
import { isUnder } from "./links";

/**
 * How long a file found is trusted before it is looked up again. One not
 * found is looked up each time, as the agent may make it the next moment.
 */
const FRESH_MS = 30_000;

/**
 * Looks a file up by its path relative to the workspace root, or by its
 * absolute path outside it: whether it is a file.
 */
export type FileLookup = (workspaceId: string, relPath: string) => Promise<boolean>;

/** Whether a tab of the workspace granted the previews `path`, outside it. */
export type OutsideGrantCheck = (workspaceId: string, path: string) => boolean;

const lookUpInWorkspace: FileLookup = async (workspaceId, relPath) => {
  if (isAbsoluteOutsidePath(relPath)) {
    // Main reads a granted file outside the root but stats none: no bytes
    // of it say it is there, and a folder fails.
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

/**
 * The path to look `path` up by in the workspace at `root`; null for one
 * outside it, which a workspace cannot look up.
 */
export function lookupPath(path: string, root: string): string | null {
  if (!root || !isUnder(path, root)) return null;
  // A Windows root may end in a backslash (C:\), and the path use slashes.
  const base = root.replace(/[\\/]+$/, "");
  return path.length > base.length ? path.slice(base.length + 1) : null;
}

/**
 * The path to look `path` up by: under the workspace at `root`, or itself
 * when it is outside it and granted; null when it cannot be looked up.
 */
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

/** Answers what files are there, each lookup shared and a file found kept a while. */
export function createFilePresence(
  lookUp: FileLookup = lookUpInWorkspace,
  now: () => number = Date.now,
  granted: OutsideGrantCheck = grantedOutside,
) {
  const found = new Map<string, number>();
  const asking = new Map<string, Promise<boolean>>();
  return {
    /** True when `path` was found a moment ago; undefined when it has to be looked up. */
    known(workspaceId: string, path: string): true | undefined {
      const at = found.get(`${workspaceId}\u0000${path}`);
      return at !== undefined && now() - at < FRESH_MS ? true : undefined;
    },
    /** Whether `path`, in the workspace at `root` or granted outside it, is a file. */
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

/**
 * Most lookups filesThere has going at once: each is a call to the agent,
 * which takes only so many at a time (128) from all the app asks it, and
 * a long conversation names hundreds of images.
 */
const MAX_LOOKUPS = 32;

/**
 * Which of `paths`, in the workspace at `root` or granted outside it, are
 * files, as `presence` answers; at most `max` looked up at once.
 */
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

/**
 * Which of `paths` are gone: looked up, in the workspace at `root` or
 * granted outside it, and not found. One that cannot be looked up (yet),
 * as a file outside not granted, is not gone.
 */
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

/** Which of `paths`, in the workspace at `root` or granted outside it, are files. */
export function filesThere(
  workspaceId: string,
  root: string,
  paths: readonly string[],
): Promise<ReadonlySet<string>> {
  return filesFound(presence, workspaceId, root, paths);
}

/**
 * Which of `paths`, in the workspace at `root` or granted outside it, are
 * files; looked up again whenever `recheck` changes, as when a tool of the
 * agent's is done, and as a file outside is granted.
 */
export function useFoundFiles(
  workspaceId: string,
  root: string,
  paths: readonly string[],
  recheck: unknown = null,
): ReadonlySet<string> {
  const key = paths.join("\n");
  // The tab grants what it names a moment after it names it.
  const outside = useOutsideGrantsStore((s) =>
    paths.filter((path) => isOutsideGranted(s.byWorkspace, workspaceId, path)).join("\n"),
  );
  // Another computer's chat finds them there.
  const files = useChatFiles();
  const scope = files ? (files.access?.scope ?? null) : undefined;
  const [found, setFound] = useState<{ scope: typeof scope; paths: ReadonlySet<string> }>(() => ({
    scope,
    paths: files ? EMPTY_PATHS : new Set(paths.filter((path) => presence.known(workspaceId, path))),
  }));
  if (found.scope !== scope) setFound({ scope, paths: EMPTY_PATHS });
  // `key` stands for `paths`, which is a new array each render.
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

/**
 * Which of `paths`, in the workspace at `root` or granted outside it, are
 * gone (filesGone): none until the lookup answers, so a file that is there
 * never shows as gone first. Looked up again as a file outside is granted.
 */
export function useGoneFiles(
  workspaceId: string,
  root: string,
  paths: readonly string[],
): ReadonlySet<string> {
  const key = paths.join("\n");
  // The tab grants what it names a moment after it names it.
  const outside = useOutsideGrantsStore((s) =>
    paths.filter((path) => isOutsideGranted(s.byWorkspace, workspaceId, path)).join("\n"),
  );
  const [gone, setGone] = useState<ReadonlySet<string>>(EMPTY_PATHS);
  // `key` stands for `paths`, which is a new array each render.
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
