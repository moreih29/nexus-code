import { promises as nodeFs } from "node:fs";
import path from "node:path";
import {
  MAX_BYTES_CHUNK,
  MAX_LIST_ENTRIES,
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
} from "../../../../packages/remote-protocol/src";
import { FS_ERROR, hasFsErrorCode } from "../../../shared/fs/errors";
import {
  isAutoMountPath,
  isDevicePath,
  isNetworkOrDevicePath,
  windowsPathKind,
} from "../../../shared/fs/outside-url";
import type { FsPreviewPath } from "../../../shared/fs/protocol";
import type { DirEntry } from "../../../shared/fs/types";
import { decodable } from "../../../shared/remote/image-size";
import type { FsProvider } from "../fs/bridge/provider";
import { networkLinkOf } from "../fs/link-walk";
import { asciiLower } from "../fs/outside-grants";
import { grantRequired } from "./file-grants";
import { validFileName } from "./file-io";
import { fitsInFrame, MAX_MESSAGE_BYTES, RpcFailure } from "./room";

export const DEFAULT_READ_BYTES = 128 * 1024;

const IMAGE_CHARS = MAX_MESSAGE_BYTES - 2048;

const MAX_IMAGE_FILE_BYTES = 32 * 1024 * 1024;

const SNIFF_BYTES = 8000;

const IMAGE_TYPES: Readonly<
  Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp">
> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export interface RemoteFiles {
  fs: (workspaceId: string) => Promise<FsProvider>;
  folders: (workspaceId: string) => Promise<readonly string[]>;
  named?: (workspaceId: string) => Promise<readonly string[]>;
  shrink: (bytes: Buffer, maxChars: number) => { mediaType: "image/jpeg"; data: string } | null;
}

export type Place = { kind: "workspace"; rel: string } | { kind: "folder"; absolute: string };

function forbidden(message: string): RpcFailure {
  return new RpcFailure(RpcErrorCode.Forbidden, message);
}

const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;

const WINDOWS_ANCHORED = /^(?:[\\/]|[A-Za-z]:)/;

export interface PathStyle {
  readonly windows: boolean;
  readonly sep: "/" | "\\";
  readonly path: typeof path.posix;
}

const POSIX: PathStyle = { windows: false, sep: "/", path: path.posix };
const WINDOWS: PathStyle = { windows: true, sep: "\\", path: path.win32 };

export function styleOf(root: string): PathStyle {
  return WINDOWS_ABSOLUTE.test(root) ? WINDOWS : POSIX;
}

const trimSlashes = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

function clean(style: PathStyle, p: string): string {
  if (!style.windows) return trimSlashes(path.posix.normalize(p));
  const normal = path.win32.normalize(p);
  const root = path.win32.parse(normal).root;
  return normal.length > root.length ? normal.replace(/\\+$/, "") : normal;
}

function inside(style: PathStyle, outer: string, inner: string): string | undefined {
  const head = inner.slice(0, outer.length);
  if (style.windows ? head.toLowerCase() !== outer.toLowerCase() : head !== outer) return;
  if (inner.length === outer.length) return "";
  if (outer.endsWith(style.sep)) return inner.slice(outer.length);
  return inner[outer.length] === style.sep ? inner.slice(outer.length + 1) : undefined;
}

function within(style: PathStyle, outer: string, inner: string): boolean {
  return inside(style, outer, inner) !== undefined;
}

function absoluteIn(style: PathStyle, base: string, rel: string): string {
  if (!rel) return base;
  return style.windows ? path.win32.join(base, rel) : `${base}/${rel}`;
}

export function hostFilePath(root: string, p: string): string {
  const style = styleOf(root);
  return clean(style, style.windows ? p.replace(/\//g, "\\") : p);
}

export function isAbsoluteFor(root: string, p: string): boolean {
  return styleOf(root).windows ? WINDOWS_ABSOLUTE.test(p) : p.startsWith("/");
}

export function sameHostPath(root: string, a: string, b: string): boolean {
  const left = hostFilePath(root, a);
  const right = hostFilePath(root, b);
  return styleOf(root).windows ? asciiLower(left) === asciiLower(right) : left === right;
}

export function placeOf(root: string, folders: readonly string[], asked: string): Place {
  if (asked.includes("\0")) throw forbidden("that is no path");
  const style = styleOf(root);
  const base = clean(style, root);
  const absolutePath = style.windows ? WINDOWS_ABSOLUTE.test(asked) : asked.startsWith("/");
  if (!absolutePath) {
    if (style.windows && WINDOWS_ANCHORED.test(asked)) {
      throw forbidden(`${asked} is outside the workspace's folders`);
    }
    const rel = clean(style, asked || ".");
    if (rel === ".." || rel.startsWith(`..${style.sep}`)) {
      throw forbidden(`${asked} is outside the workspace's folder`);
    }
    return { kind: "workspace", rel: rel === "." ? "" : rel.split(style.sep).join("/") };
  }
  const absolute = clean(style, asked);
  const rest = inside(style, base, absolute);
  if (rest !== undefined) {
    return { kind: "workspace", rel: style.windows ? rest.split("\\").join("/") : rest };
  }
  const folder = folders.map((f) => clean(style, f)).find((f) => within(style, f, absolute));
  if (folder) return { kind: "folder", absolute };
  throw forbidden(`${asked} is outside the workspace's folders`);
}

export function absoluteFilePath(asked: string): string {
  const windows = process.platform === "win32";
  if (
    asked.includes("\0") ||
    (windows ? !WINDOWS_ABSOLUTE.test(asked) || isDevicePath(asked) : !path.isAbsolute(asked))
  ) {
    throw forbidden("an absolute file path on this computer is required");
  }
  const cleanPath = clean(windows ? WINDOWS : POSIX, asked);
  const parts = cleanPath.slice(path.parse(cleanPath).root.length).split(path.sep).filter(Boolean);
  if (windows && !parts.every((part) => validFileName(part, path))) {
    throw forbidden("that is no file path on this computer");
  }
  return cleanPath;
}

function readForms(asked: string, cleaned: readonly string[]): string[] {
  return [asked, ...cleaned].flatMap((p) => [p, path.posix.normalize(p)]);
}

function refuseDeviceRead(asked: string, absolute: string, done = "read"): void {
  if (readForms(asked, [absolute]).some(isDevicePath)) {
    throw forbidden(`${asked} is a device path: it is not ${done} from another device`);
  }
}

export function namesNetworkPath(asked: string, ...cleaned: string[]): boolean {
  return readForms(asked, cleaned).some((p) => isNetworkOrDevicePath(p) || isAutoMountPath(p));
}

const FIRMLINKED = ["system", "volumes", "data"];

export function networkRootOf(p: string): string | null {
  if (windowsPathKind(p) === "unc") {
    const share = /^\\\\([^\\]+)\\([^\\]+)/.exec(path.win32.normalize(p));
    return share ? asciiLower(`\\\\${share[1]}\\${share[2]}`) : null;
  }
  if (!isAutoMountPath(p)) return null;
  const parts = path.posix
    .normalize(p)
    .split("/")
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  const top = FIRMLINKED.every((part, i) => parts[i] === part) ? FIRMLINKED.length : 0;
  const depth = parts[top] === "network" && parts[top + 1] === "servers" ? 3 : 2;
  const root = parts.slice(top, top + depth);
  return root.length === depth ? `/${root.join("/")}` : null;
}

function refuseNetworkRead(asked: string, absolute?: string, done = "read"): void {
  if (namesNetworkPath(asked, ...(absolute === undefined ? [] : [absolute]))) {
    throw forbidden(`${asked} is a network or device path: it is not ${done} from another device`);
  }
}

export function absoluteReadPath(asked: string, consented = false): string {
  const absolute = absoluteFilePath(asked);
  refuseDeviceRead(asked, absolute);
  if (!consented) refuseNetworkRead(asked, absolute);
  return absolute;
}

function inNetworkFolder(windows: boolean, absolute: string, folders: readonly string[]): boolean {
  if (!windows) {
    const target = clean(POSIX, absolute);
    return (
      isAutoMountPath(target) &&
      folders.some((folder) => {
        const outer = clean(POSIX, folder);
        return isAutoMountPath(outer) && within(POSIX, outer, target);
      })
    );
  }
  if (windowsPathKind(absolute) !== "unc") return false;
  const target = asciiLower(clean(WINDOWS, absolute));
  return folders.some((folder) => {
    const outer = clean(WINDOWS, folder);
    if (windowsPathKind(outer) !== "unc") return false;
    const key = asciiLower(outer);
    return target === key || target.startsWith(key.endsWith("\\") ? key : `${key}\\`);
  });
}

export function refuseOutsideRead(
  windows: boolean,
  folders: readonly string[],
  asked: string,
  absolute: string,
  done: "read" | "written" = "read",
): void {
  refuseDeviceRead(asked, absolute, done);
  if (inNetworkFolder(windows, absolute, folders)) return;
  refuseNetworkRead(asked, absolute, done);
}

function refuseFolderRead(
  root: string,
  folders: readonly string[],
  asked: string,
  absolute: string,
): void {
  refuseOutsideRead(styleOf(root).windows, folders, asked, absolute);
}

export async function outsideFileSource(asked: string): Promise<string> {
  return realOf(absoluteFilePath(asked), asked);
}

export type LinkMode = "auto" | "click";

export async function networkLinkRefusal(
  absolute: string,
  asked: string,
  mode: LinkMode = "auto",
): Promise<RpcFailure | null> {
  if (namesNetworkPath(asked, absolute)) return null;
  let hop: string | null;
  try {
    hop = await networkLinkOf(absolute);
  } catch {
    return forbidden(`${asked} goes through too many links`);
  }
  if (hop === null) return null;
  if (mode === "click" && isAutoMountPath(path.posix.normalize(hop.replace(/\\/g, "/")))) {
    return null;
  }
  return forbidden(`${asked} leads to a network or device path through a link`);
}

export async function refuseNetworkLink(
  absolute: string,
  asked: string,
  mode: LinkMode = "auto",
): Promise<void> {
  const refusal = await networkLinkRefusal(absolute, asked, mode);
  if (refusal) throw refusal;
}

export async function outsideRealPath(
  absolute: string,
  asked: string,
  mode: LinkMode,
): Promise<string> {
  return realOf(absolute, asked, mode);
}

async function realOf(absolute: string, asked: string, mode: LinkMode = "auto"): Promise<string> {
  await refuseNetworkLink(absolute, asked, mode);
  return nodeFs.realpath(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      throw new RpcFailure(RpcErrorCode.NotFound, `${asked} does not exist`);
    }
    throw new RpcFailure(RpcErrorCode.Unavailable, "the file could not be resolved");
  });
}

async function placeToRead(
  files: RemoteFiles,
  workspaceId: string,
  root: string,
  folders: readonly string[],
  asked: string,
): Promise<Place | { kind: "folder"; absolute: string; output: true }> {
  let place: Place;
  try {
    place = placeOf(root, folders, asked);
  } catch (error) {
    if (!(error instanceof RpcFailure) || error.code !== RpcErrorCode.Forbidden) throw error;
    if (asked.includes("\0")) throw error;
    const real = await underRealRoot(files, workspaceId, root, asked);
    if (real !== null) return real;
    if (!files.named) throw error;
    const style = styleOf(root);
    const wanted = clean(style, asked);
    refuseNetworkRead(asked, wanted);
    const same = (a: string) =>
      style.windows ? a.toLowerCase() === wanted.toLowerCase() : a === wanted;
    const named = await files.named(workspaceId);
    if (!named.some((o) => same(clean(style, o)))) {
      const absolute = style.windows ? WINDOWS_ABSOLUTE.test(asked) : asked.startsWith("/");
      throw absolute ? grantRequired(error.message) : error;
    }
    return { kind: "folder", absolute: wanted, output: true };
  }
  if (place.kind === "folder") refuseFolderRead(root, folders, asked, place.absolute);
  return place;
}

export async function realRootOf(
  files: Pick<RemoteFiles, "fs">,
  workspaceId: string,
  root: string,
): Promise<string | null> {
  const fs = await files.fs(workspaceId).catch(() => null);
  if (fs?.kind !== "local") return null;
  const real = await nodeFs.realpath(root).catch(() => null);
  return real === null || real === root ? null : real;
}

async function underRealRoot(
  files: Pick<RemoteFiles, "fs">,
  workspaceId: string,
  root: string,
  asked: string,
): Promise<Place | null> {
  const style = styleOf(root);
  if (!(style.windows ? WINDOWS_ABSOLUTE.test(asked) : asked.startsWith("/"))) return null;
  if (namesNetworkPath(asked, clean(style, asked))) return null;
  const real = await realRootOf(files, workspaceId, root);
  if (real === null) return null;
  const rest = inside(style, clean(style, real), clean(style, asked));
  if (rest === undefined) return null;
  return { kind: "workspace", rel: style.windows ? rest.split("\\").join("/") : rest };
}

export async function placeOrRealRoot(
  files: Pick<RemoteFiles, "fs">,
  workspaceId: string,
  root: string,
  folders: readonly string[],
  asked: string,
): Promise<Place> {
  try {
    return placeOf(root, folders, asked);
  } catch (error) {
    if (!(error instanceof RpcFailure) || asked.includes("\0")) throw error;
    const real = await underRealRoot(files, workspaceId, root, asked);
    if (real === null) throw error;
    return real;
  }
}

function notFound(error: unknown, asked: string): never {
  if (hasFsErrorCode(error, FS_ERROR.NOT_FOUND)) {
    throw new RpcFailure(RpcErrorCode.NotFound, `${asked} does not exist`);
  }
  if (hasFsErrorCode(error, FS_ERROR.NOT_DIRECTORY)) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, `${asked} is a file: files.read reads it`);
  }
  throw new RpcFailure(
    RpcErrorCode.Unavailable,
    error instanceof Error ? error.message : String(error),
  );
}

export async function throughNoLink(fs: FsProvider, rel: string, asked: string) {
  const parts = rel ? rel.split("/") : [];
  let stat = await fs.stat("").catch((error: unknown) => notFound(error, asked));
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    stat = await fs.stat(prefix).catch((error: unknown) => notFound(error, asked));
    if (stat.isSymlink) throw forbidden(`${prefix} is a link: what it points to is not read`);
  }
  return stat;
}

export function untrackedReader(
  fs: (workspaceId: string) => Promise<FsProvider>,
  rootOf: (workspaceId: string) => string | undefined,
) {
  return async (workspaceId: string, absolute: string, maxBytes: number): Promise<string> => {
    const root = rootOf(workspaceId);
    if (root === undefined) throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
    const place = placeOf(root, [], absolute);
    if (place.kind !== "workspace")
      throw forbidden(`${absolute} is outside the workspace's folder`);
    validatePathParts(root, place.rel);
    const provider = await fs(workspaceId);
    await throughNoLink(provider, place.rel, absolute);
    const read = await provider.readRange(place.rel, 0, maxBytes);
    if (read.kind === "missing") return "";
    return new TextDecoder("utf-8").decode(Buffer.from(read.base64, "base64"), { stream: true });
  };
}

export async function folderIn(
  fs: FsProvider | null,
  root: string,
  asked: string,
): Promise<string> {
  const place = placeOf(root, [], asked);
  if (place.kind !== "workspace") throw forbidden(`${asked} is outside the workspace's folder`);
  validatePathParts(root, place.rel);
  if (fs) {
    const stat = await throughNoLink(fs, place.rel, asked);
    if (stat.type !== "dir") {
      throw new RpcFailure(RpcErrorCode.InvalidParams, `${asked} is a file, not a folder`);
    }
  }
  const style = styleOf(root);
  return absoluteIn(style, clean(style, root), place.rel);
}

export async function realWithin(
  fs: FsProvider,
  style: PathStyle,
  folders: readonly string[],
  absolute: string,
): Promise<string> {
  if (fs.kind !== "local") {
    throw new RpcFailure(
      RpcErrorCode.Unavailable,
      "a folder outside the workspace's is read only on this computer, not on its host",
    );
  }
  if (!inNetworkFolder(style.windows, absolute, folders))
    await refuseNetworkLink(absolute, absolute);
  const real = await nodeFs.realpath(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT")
      throw new RpcFailure(RpcErrorCode.NotFound, `${absolute} does not exist`);
    throw new RpcFailure(RpcErrorCode.Unavailable, "the file could not be resolved");
  });
  const granting = folders.filter(
    (f) => !namesNetworkPath(f) || inNetworkFolder(style.windows, absolute, [f]),
  );
  const reals = await Promise.all(granting.map((f) => nodeFs.realpath(f).catch(() => null)));
  const canonicalStyle = style.windows ? { ...style, windows: false } : style;
  if (!reals.some((f) => f && within(canonicalStyle, clean(style, f), clean(style, real)))) {
    throw forbidden(`${absolute} leads outside the workspace's folders`);
  }
  return real;
}

type Entry = RpcResult<"files.list">["entries"][number];

function entryOf(entry: DirEntry): Entry {
  const kind = entry.type === "dir" ? "dir" : entry.type === "symlink" ? "link" : "file";
  return {
    name: entry.name,
    kind,
    ...(kind === "file" && entry.size !== undefined ? { size: entry.size } : {}),
  };
}

export function validatePathParts(root: string, relative: string): void {
  const style = styleOf(root);
  if (relative && !relative.split("/").every((part) => validFileName(part, style.path))) {
    throw forbidden("that path contains an invalid name");
  }
}

export async function listFiles(
  files: RemoteFiles,
  root: string,
  { workspaceId, path: asked, anywhere }: RpcParams<"files.list">,
  approvedPath?: string,
): Promise<RpcResult<"files.list">> {
  const folders = anywhere ? [] : await files.folders(workspaceId);
  const place: Place = anywhere
    ? { kind: "folder", absolute: absoluteReadPath(asked, approvedPath !== undefined) }
    : await placeOrRealRoot(files, workspaceId, root, folders, asked);
  if (!anywhere && place.kind === "folder") refuseFolderRead(root, folders, asked, place.absolute);
  const style = styleOf(root);
  const fs = await files.fs(workspaceId);
  if (!fs.readdirNoLinks)
    throw new RpcFailure(RpcErrorCode.Unavailable, "secure folder listing is unavailable");
  let entries: Entry[];
  let absolute: string;
  if (place.kind === "workspace") {
    validatePathParts(root, place.rel);
    const stat = await throughNoLink(fs, place.rel, asked);
    if (stat.type !== "dir") {
      throw new RpcFailure(RpcErrorCode.InvalidParams, `${asked} is a file: files.read reads it`);
    }
    entries = (
      await fs
        .readdirNoLinks({ relPath: place.rel })
        .catch((error: unknown) => notFound(error, asked))
    ).map(entryOf);
    absolute = absoluteIn(style, clean(style, root), place.rel);
  } else {
    if (fs.kind !== "local") {
      throw new RpcFailure(
        RpcErrorCode.Unavailable,
        "a folder outside the workspace's is listed only on this computer, not on its host",
      );
    }
    if (style.windows) absoluteFilePath(place.absolute);
    const resolved = anywhere
      ? (approvedPath ?? (await outsideFileSource(place.absolute)))
      : await realWithin(fs, style, folders, place.absolute);
    entries = (
      await fs
        .readdirNoLinks({ absolutePath: resolved })
        .catch((error: unknown) => notFound(error, asked))
    ).map(entryOf);
    const stillAllowed = anywhere
      ? await outsideFileSource(place.absolute)
      : await realWithin(fs, style, await files.folders(workspaceId), place.absolute);
    if (stillAllowed !== resolved) throw fileChanged(false);
    absolute = place.absolute;
  }
  entries.sort((a, b) =>
    (a.kind === "dir") !== (b.kind === "dir")
      ? a.kind === "dir"
        ? -1
        : 1
      : a.name.localeCompare(b.name),
  );
  const truncated = entries.length > MAX_LIST_ENTRIES;
  return {
    path: absolute,
    entries: truncated ? entries.slice(0, MAX_LIST_ENTRIES) : entries,
    ...(truncated ? { truncated: true } : {}),
  };
}

export function textOf(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes, { stream: true });
}

export function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, SNIFF_BYTES).includes(0);
}

export async function readFile(
  files: RemoteFiles,
  root: string,
  {
    workspaceId,
    path: asked,
    maxBytes = DEFAULT_READ_BYTES,
    as,
    offset,
    length,
    versioned,
    ifVersion,
    requireVersion,
    anywhere,
  }: RpcParams<"files.read">,
  approvedPath?: string,
  granted?: { path: string; realPath: string | null },
): Promise<RpcResult<"files.read">> {
  const optedIn = versioned === true || ifVersion !== undefined || requireVersion !== undefined;
  if (ifVersion !== undefined && requireVersion !== undefined) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, "use either ifVersion or requireVersion");
  }
  if (requireVersion !== undefined && as !== "bytes") {
    throw new RpcFailure(RpcErrorCode.InvalidParams, 'requireVersion is taken with as: "bytes"');
  }
  if (as !== "bytes" && (offset !== undefined || length !== undefined)) {
    throw new RpcFailure(
      RpcErrorCode.InvalidParams,
      'offset and length are taken with as: "bytes"',
    );
  }
  if (length === 0 && !optedIn) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, "a zero-length read requires version opt-in");
  }
  const folders = anywhere ? [] : await files.folders(workspaceId);
  const place:
    | Place
    | { kind: "folder"; absolute: string; output: true; granted?: { realPath: string | null } } =
    anywhere
      ? { kind: "folder", absolute: absoluteReadPath(asked, approvedPath !== undefined) }
      : granted
        ? {
            kind: "folder",
            absolute: granted.path,
            output: true,
            granted: { realPath: granted.realPath },
          }
        : await placeToRead(files, workspaceId, root, folders, asked);
  const grantedReal = "granted" in place ? place.granted?.realPath : undefined;
  const style = styleOf(root);
  const fs = await files.fs(workspaceId);
  let source: FsPreviewPath;
  let absolute: string;
  if (place.kind === "workspace") {
    if (!place.rel)
      throw new RpcFailure(
        RpcErrorCode.InvalidParams,
        "that is the workspace's folder: files.list lists it",
      );
    validatePathParts(root, place.rel);
    source = { relPath: place.rel };
    absolute = absoluteIn(style, clean(style, root), place.rel);
  } else {
    absolute = place.absolute;
    source = anywhere
      ? { absolutePath: absolute, ...(approvedPath ? { expectedRealPath: approvedPath } : {}) }
      : grantedReal !== undefined
        ? {
            absolutePath: absolute,
            ...(grantedReal !== null ? { expectedRealPath: grantedReal } : {}),
          }
        : "output" in place
          ? {
              absolutePath: absolute,
              ...(fs.kind === "local" ? { expectedRealPath: await realOf(absolute, asked) } : {}),
            }
          : {
              absolutePath: absolute,
              expectedRealPath: await realWithin(fs, style, folders, absolute),
            };
  }
  const mediaType =
    as === "bytes" ? undefined : IMAGE_TYPES[style.path.extname(absolute).toLowerCase()];
  const from = offset ?? 0;
  const readLength = as === "bytes" ? (length ?? MAX_BYTES_CHUNK) : mediaType ? 0 : maxBytes;

  const verifyGrant = async () => {
    if (anywhere || place.kind !== "folder") return;
    if (grantedReal !== undefined) {
      if (grantedReal !== null && (await realOf(absolute, asked, "click")) !== grantedReal) {
        throw fileChanged(requireVersion !== undefined);
      }
      return;
    }
    const currentFolders = await files.folders(workspaceId);
    const current = await placeToRead(files, workspaceId, root, currentFolders, asked);
    if (current.kind !== "folder" || "output" in current !== "output" in place) {
      throw forbidden(`${asked} no longer has the same file grant`);
    }
    if (!("expectedRealPath" in source)) return;
    const real =
      "output" in place
        ? await realOf(absolute, asked)
        : await realWithin(fs, style, currentFolders, absolute);
    if (real !== source.expectedRealPath) throw fileChanged(requireVersion !== undefined);
  };
  const preview = await fs
    .readPreview?.({
      ...source,
      offset: from,
      length: readLength,
      ...(mediaType ? { wholeImage: true } : {}),
      ...(optedIn ? { versionScope: workspaceId, ifVersion, requireVersion } : {}),
    })
    .catch((error: unknown) => previewError(error, asked, requireVersion !== undefined));
  if (preview) {
    await verifyGrant();
    if (preview.kind === "notModified") {
      if (ifVersion !== preview.version) throw fileChanged(false);
      return preview;
    }
    if (requireVersion !== undefined && requireVersion !== preview.version) throw fileChanged(true);
    const version = optedIn ? preview.version : undefined;
    const content =
      as === "bytes"
        ? bytesPreview(absolute, from, preview.base64, preview.sizeBytes)
        : mediaType
          ? imagePreview(files, absolute, mediaType, preview.base64, preview.sizeBytes)
          : textPreview(absolute, preview.base64, preview.sizeBytes);
    return version === undefined ? content : { ...content, version };
  }

  if (anywhere) {
    const target = await nodeFs.stat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        throw new RpcFailure(RpcErrorCode.NotFound, `${asked} does not exist`);
      }
      throw new RpcFailure(RpcErrorCode.Unavailable, "the file could not be read");
    });
    if (target.isDirectory()) throw folderReadError(asked);
    if (!target.isFile())
      throw new RpcFailure(RpcErrorCode.InvalidParams, "a regular file is required");
    throw new RpcFailure(
      RpcErrorCode.Unavailable,
      "the filesystem agent must be updated to read this file",
    );
  }
  const legacy = await legacyPreview(
    fs,
    files,
    place,
    asked,
    absolute,
    from,
    readLength,
    mediaType,
    as,
    requireVersion,
  );
  await verifyGrant();
  return legacy;
}

async function legacyPreview(
  fs: FsProvider,
  files: RemoteFiles,
  place: Place,
  asked: string,
  absolute: string,
  from: number,
  readLength: number,
  mediaType: (typeof IMAGE_TYPES)[string] | undefined,
  as: "bytes" | undefined,
  requireVersion: string | undefined,
): Promise<RpcResult<"files.read">> {
  let size: number | undefined;
  if (place.kind === "workspace") {
    const stat = await throughNoLink(fs, place.rel, asked);
    if (stat.type === "dir") throw folderReadError(asked);
    size = stat.size;
  }
  if (requireVersion !== undefined) throw fileChanged(true);
  const range = (length: number, from = 0) =>
    (place.kind === "workspace"
      ? fs.readRange(place.rel, from, length)
      : fs.readAbsoluteRange(place.absolute, from, length)
    ).catch((error: unknown) => notFound(error, asked));

  if (as === "bytes") {
    const read = await range(readLength, from);
    if (read.kind === "missing")
      throw new RpcFailure(RpcErrorCode.NotFound, `${asked} does not exist`);
    return bytesPreview(absolute, from, read.base64, read.sizeBytes);
  }

  if (mediaType) {
    let total = size;
    if (total === undefined) {
      const head = await range(1);
      if (head.kind === "missing")
        throw new RpcFailure(RpcErrorCode.NotFound, `${asked} does not exist`);
      total = head.sizeBytes;
    }
    if (total <= MAX_IMAGE_FILE_BYTES) {
      const whole = await (place.kind === "workspace"
        ? fs.readBinary(place.rel)
        : fs.readAbsoluteBinary(place.absolute)
      ).catch((error: unknown) => notFound(error, asked));
      if (whole.kind === "missing")
        throw new RpcFailure(RpcErrorCode.NotFound, `${asked} does not exist`);
      return imagePreview(files, absolute, mediaType, whole.base64, total);
    }
    return { kind: "binary", path: absolute, size: total };
  }

  const read = await range(readLength);
  if (read.kind === "missing")
    throw new RpcFailure(RpcErrorCode.NotFound, `${asked} does not exist`);
  return textPreview(absolute, read.base64, size ?? read.sizeBytes);
}

function folderReadError(asked: string): RpcFailure {
  return new RpcFailure(RpcErrorCode.InvalidParams, `${asked} is a folder: files.list lists it`);
}

function fileChanged(pinned: boolean): RpcFailure {
  return new RpcFailure(
    pinned ? RpcErrorCode.InvalidParams : RpcErrorCode.Unavailable,
    pinned ? "file version changed" : "the file changed while it was being read",
  );
}

function previewError(error: unknown, asked: string, pinned: boolean): never {
  if (hasFsErrorCode(error, FS_ERROR.OUT_OF_WORKSPACE)) {
    throw forbidden(`${asked} leads outside the workspace's file grant or goes through a link`);
  }
  if (hasFsErrorCode(error, FS_ERROR.IS_DIRECTORY)) throw folderReadError(asked);
  if (hasFsErrorCode(error, FS_ERROR.NOT_FOUND)) {
    throw new RpcFailure(RpcErrorCode.NotFound, `${asked} does not exist`);
  }
  if (hasFsErrorCode(error, FS_ERROR.STALE)) throw fileChanged(pinned);
  throw new RpcFailure(RpcErrorCode.Unavailable, "the file could not be read");
}

function bytesPreview(path: string, offset: number, data: string, size: number) {
  return { kind: "bytes" as const, path, data, offset, size };
}

function imagePreview(
  files: RemoteFiles,
  path: string,
  mediaType: (typeof IMAGE_TYPES)[string],
  data: string,
  size: number,
): Extract<RpcResult<"files.read">, { kind: "image" | "binary" }> {
  if (size <= MAX_IMAGE_FILE_BYTES) {
    const bytes = Buffer.from(data, "base64");
    if (decodable(bytes)) {
      if (data.length <= IMAGE_CHARS) return { kind: "image", path, mediaType, data, size };
      const shrunk = files.shrink(bytes, IMAGE_CHARS);
      if (shrunk) return { kind: "image", path, ...shrunk, size };
    }
  }
  return { kind: "binary", path, size };
}

function textPreview(
  absolute: string,
  base64: string,
  total: number,
): Extract<RpcResult<"files.read">, { kind: "text" | "binary" }> {
  const bytes = Buffer.from(base64, "base64");
  if (looksBinary(bytes)) return { kind: "binary", path: absolute, size: total };
  let text = textOf(bytes);
  let truncated = bytes.length < total;
  while (
    !fitsInFrame({
      result: { kind: "text", path: absolute, text, size: total, truncated },
      pad: "x".repeat(1024),
    })
  ) {
    text = text.slice(0, Math.floor((text.length * 3) / 4));
    truncated = true;
  }
  return { kind: "text", path: absolute, text, size: total, truncated };
}
