import { promises as nodeFs } from "node:fs";
import path from "node:path";
import {
  isAutoMountPath,
  isDevicePath,
  isNetworkOrDevicePath,
} from "../../../shared/fs/outside-url";

export const MAX_LINK_STEPS = 40;

export interface LinkFs {
  lstat(p: string): Promise<{ isSymbolicLink(): boolean }>;
  readlink(p: string): Promise<string>;
}

export function isNetworkTarget(p: string): boolean {
  return [p, path.posix.normalize(p)].some(
    (form) => isNetworkOrDevicePath(form) || isAutoMountPath(form),
  );
}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function targetOf(style: typeof path.posix, link: string, raw: string): string {
  const drive = /^(?:\\\\\?\\|\\\?\?\\)([A-Za-z]:\\.*)$/.exec(raw);
  const plain = style === path.win32 && drive?.[1] ? drive[1] : raw;
  if (isNetworkTarget(plain)) return plain;
  return style.isAbsolute(plain) ? style.normalize(plain) : style.join(style.dirname(link), plain);
}

function partsOf(style: typeof path.posix, p: string): { root: string; parts: string[] } {
  const root = style.parse(p).root;
  return {
    root,
    parts: p
      .slice(root.length)
      .split(style === path.win32 ? /[\\/]+/ : /\/+/)
      .filter(Boolean),
  };
}

export async function networkLinkOf(
  start: string,
  fs: LinkFs = nodeFs,
  style: typeof path.posix = path,
): Promise<string | null> {
  if (isNetworkTarget(start)) return null;
  const first = partsOf(style, start);
  let current = first.root;
  const pending = first.parts;
  let steps = 0;
  while (pending.length > 0) {
    const part = pending.shift() as string;
    if (part === ".") continue;
    if (part === "..") {
      current = style.dirname(current);
      continue;
    }
    const next = style.join(current, part);
    let linked: boolean;
    try {
      linked = (await fs.lstat(next)).isSymbolicLink();
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    if (!linked) {
      current = next;
      continue;
    }
    steps += 1;
    if (steps > MAX_LINK_STEPS) {
      throw Object.assign(new Error(`too many links on the way to ${start}`), { code: "ELOOP" });
    }
    const target = targetOf(style, next, await fs.readlink(next));
    if (isNetworkTarget(target) || isDevicePath(target)) return target;
    const rest = partsOf(style, target);
    current = rest.root;
    pending.unshift(...rest.parts);
  }
  return null;
}
