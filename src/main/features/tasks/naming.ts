import { createHash } from "node:crypto";
import { type WorkspaceMeta, workspaceLocationKey } from "../../../shared/types/workspace";

const MAX_SLUG_LENGTH = 40;

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

export function uniqueName(slug: string, isTaken: (name: string) => boolean): string {
  if (!isTaken(slug)) return slug;
  for (let n = 2; ; n += 1) {
    const candidate = `${slug}-${n}`;
    if (!isTaken(candidate)) return candidate;
  }
}

export function repoFolderName(parent: WorkspaceMeta): string {
  const hash = createHash("sha256")
    .update(workspaceLocationKey(parent.location))
    .digest("hex")
    .slice(0, 6);
  const base = taskSlug(parent.rootPath.split(/[\\/]/).filter(Boolean).pop() ?? "") || "repo";
  return `${base}-${hash}`;
}

export function subPathInRepo(rootPath: string, topLevel: string): string {
  const root = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const top = topLevel.replace(/\\/g, "/").replace(/\/+$/, "");
  return root.startsWith(`${top}/`) ? root.slice(top.length + 1) : "";
}
