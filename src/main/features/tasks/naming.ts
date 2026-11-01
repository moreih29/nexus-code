import { createHash } from "node:crypto";
import { type WorkspaceMeta, workspaceLocationKey } from "../../../shared/types/workspace";

/** Longest slug a task name turns into; keeps branch names and paths short. */
const MAX_SLUG_LENGTH = 40;

/**
 * The branch-and-folder name for a task called `name`: letters and digits
 * (any script) kept, everything else collapsed to "-". Empty when nothing
 * usable is left.
 */
export function taskSlug(name: string): string {
  return name
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/[-.]+$/g, "")
    .replace(/\.lock$/, "");
}

/** `slug`, or `slug-2`, `slug-3`… — the first that is not taken. */
export function uniqueName(slug: string, isTaken: (name: string) => boolean): string {
  if (!isTaken(slug)) return slug;
  for (let n = 2; ; n += 1) {
    const candidate = `${slug}-${n}`;
    if (!isTaken(candidate)) return candidate;
  }
}

/**
 * The folder under the worktrees root that holds one repository's tasks:
 * its name plus a hash of its location, so two repositories with the same
 * folder name never share one.
 */
export function repoFolderName(parent: WorkspaceMeta): string {
  const hash = createHash("sha256")
    .update(workspaceLocationKey(parent.location))
    .digest("hex")
    .slice(0, 6);
  const base = taskSlug(parent.rootPath.split(/[\\/]/).filter(Boolean).pop() ?? "") || "repo";
  return `${base}-${hash}`;
}

/**
 * Where the parent workspace sits inside its repository, as a relative
 * path with forward slashes: "" at the top level, "packages/app" for a
 * workspace opened on a subfolder. A task opens the same subfolder of its
 * worktree.
 */
export function subPathInRepo(rootPath: string, topLevel: string): string {
  const root = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const top = topLevel.replace(/\\/g, "/").replace(/\/+$/, "");
  return root.startsWith(`${top}/`) ? root.slice(top.length + 1) : "";
}
