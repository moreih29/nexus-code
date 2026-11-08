/**
 * Whether the files a reply only guessed at are there. A relative path in
 * backticks may be no file at all (`v0.17.0`, `os.cpus`), so a chat shows
 * one as a file only once its workspace has it.
 */

import { useEffect, useState } from "react";
import { ipcCallResult } from "@/ipc/client";
import { isUnder, resolveFilePath, resultFiles } from "./links";
import type { ResultEntry } from "./panel";

/**
 * How long a file found is trusted before it is looked up again. One not
 * found is looked up each time, as the agent may make it the next moment.
 */
const FRESH_MS = 30_000;

/** Looks a file up by its path relative to the workspace root: whether it is a file. */
export type FileLookup = (workspaceId: string, relPath: string) => Promise<boolean>;

const lookUpInWorkspace: FileLookup = async (workspaceId, relPath) => {
  const stat = await ipcCallResult("fs", "stat", { workspaceId, relPath }).catch(() => null);
  return stat?.ok === true && stat.value.type !== "dir";
};

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

/** Answers what files are there, each lookup shared and a file found kept a while. */
export function createFilePresence(
  lookUp: FileLookup = lookUpInWorkspace,
  now: () => number = Date.now,
) {
  const found = new Map<string, number>();
  const asking = new Map<string, Promise<boolean>>();
  return {
    /** True when `path` was found a moment ago; undefined when it has to be looked up. */
    known(workspaceId: string, path: string): true | undefined {
      const at = found.get(`${workspaceId}\u0000${path}`);
      return at !== undefined && now() - at < FRESH_MS ? true : undefined;
    },
    /** Whether `path`, in the workspace at `root`, is a file. */
    async isThere(workspaceId: string, root: string, path: string): Promise<boolean> {
      const key = `${workspaceId}\u0000${path}`;
      const fresh = this.known(workspaceId, path);
      if (fresh !== undefined) return fresh;
      const relPath = lookupPath(path, root);
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
 * The files `results` name, in order, as `resultFiles` has them: a guessed
 * one only once `isThere` finds it.
 */
export async function resultFilesThere(
  results: readonly ResultEntry[],
  cwd: string,
  isThere: (path: string) => Promise<boolean>,
): Promise<string[]> {
  const kept = await Promise.all(
    results.map(async (result) => {
      if (result.kind !== "file" || !result.guessed) return true;
      const path = resolveFilePath(result.target, cwd);
      return path !== null && (await isThere(path));
    }),
  );
  return resultFiles(
    results.filter((_, i) => kept[i]),
    cwd,
  );
}

const presence = createFilePresence();

/** The files a chat's results name that are there, for quick look to go through. */
export function foundResultFiles(
  workspaceId: string,
  root: string,
  results: readonly ResultEntry[],
  cwd: string,
): Promise<string[]> {
  return resultFilesThere(results, cwd, (path) => presence.isThere(workspaceId, root, path));
}

/**
 * Which of `paths`, in the workspace at `root`, are files there; looked up
 * again whenever `recheck` changes, as when a tool of the agent's is done.
 */
export function useFoundFiles(
  workspaceId: string,
  root: string,
  paths: readonly string[],
  recheck: unknown = null,
): ReadonlySet<string> {
  const key = paths.join("\n");
  const [found, setFound] = useState<ReadonlySet<string>>(
    () => new Set(paths.filter((path) => presence.known(workspaceId, path) === true)),
  );
  // `key` stands for `paths`, which is a new array each render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `recheck` only says when to look again
  useEffect(() => {
    let live = true;
    const wanted = key === "" ? [] : key.split("\n");
    void Promise.all(
      wanted.map(async (path) => ((await presence.isThere(workspaceId, root, path)) ? path : null)),
    ).then((answers) => {
      if (!live) return;
      const next = new Set(answers.filter((path): path is string => path !== null));
      setFound((was) =>
        was.size === next.size && [...next].every((path) => was.has(path)) ? was : next,
      );
    });
    return () => {
      live = false;
    };
  }, [workspaceId, root, key, recheck]);
  return found;
}
