/**
 * A workspace's files as another device reads them (files.list,
 * files.read, as text, an image or bytes): its folder's, and those of the folders its chats were
 * given (/add-dir). Nothing else: a path that climbs out of those, or one
 * that goes through a link inside the workspace (which could point
 * anywhere), is refused. Reading is always allowed, as it is here. A
 * workspace in a Windows folder takes its paths as Windows does: with
 * either separator, in any case.
 */
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
import type { FsPreviewPath } from "../../../shared/fs/protocol";
import type { DirEntry } from "../../../shared/fs/types";
import { decodable } from "../../../shared/remote/image-size";
import type { FsProvider } from "../fs/bridge/provider";
import { validFileName } from "./file-io";
import { fitsInFrame, MAX_MESSAGE_BYTES, RpcFailure } from "./room";

/** How much of a text file a read gives when it does not say. */
export const DEFAULT_READ_BYTES = 128 * 1024;

/** Room an image's base64 may take in its answer. */
const IMAGE_CHARS = MAX_MESSAGE_BYTES - 2048;

/** An image bigger than this is not read to be drawn smaller: it is told as binary. */
const MAX_IMAGE_FILE_BYTES = 32 * 1024 * 1024;

/** How many bytes of a file tell text from binary: a NUL among them is binary. */
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

/** The entries the agent leaves out of a folder's listing, as the explorer does. */
const HIDDEN = new Set([".git", ".DS_Store"]);

export interface RemoteFiles {
  /** The workspace's file system, once its agent is ready. */
  fs: (workspaceId: string) => Promise<FsProvider>;
  /** The folders the workspace's chats were given, absolute. */
  folders: (workspaceId: string) => Promise<readonly string[]>;
  /**
   * The files outside the workspace its chats name, absolute: what their
   * tools took or wrote, their replies link, and their background jobs'
   * outputs. Read by name, where they are, as each chat's previews read
   * them there.
   */
  named?: (workspaceId: string) => Promise<readonly string[]>;
  /** An image drawn small enough that its base64 takes at most `maxChars`; null when it cannot be. */
  shrink: (bytes: Buffer, maxChars: number) => { mediaType: "image/jpeg"; data: string } | null;
}

/** Where a path asked for is: inside the workspace's folder, or in a folder its chats were given. */
export type Place = { kind: "workspace"; rel: string } | { kind: "folder"; absolute: string };

function forbidden(message: string): RpcFailure {
  return new RpcFailure(RpcErrorCode.Forbidden, message);
}

/**
 * A Windows path from its start: a drive's (C:\, C:/) or a share's
 * (\\server\share, //server/share), and a device's (\\?\, \\.\).
 */
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;

/** A path Windows reads against the current drive or folder: \x, /x, C:x. */
const WINDOWS_ANCHORED = /^(?:[\\/]|[A-Za-z]:)/;

/**
 * How a workspace's paths are written, by its folder's: a Windows folder's
 * take either separator and any case, as Windows does; any other's are
 * POSIX, where a backslash is a character of a name.
 */
interface PathStyle {
  readonly windows: boolean;
  readonly sep: "/" | "\\";
  readonly path: typeof path.posix;
}

const POSIX: PathStyle = { windows: false, sep: "/", path: path.posix };
const WINDOWS: PathStyle = { windows: true, sep: "\\", path: path.win32 };

function styleOf(root: string): PathStyle {
  return WINDOWS_ABSOLUTE.test(root) ? WINDOWS : POSIX;
}

const trimSlashes = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** `p` normalized, without a separator at its end but a root's own (/, C:\, \\server\share\). */
function clean(style: PathStyle, p: string): string {
  if (!style.windows) return trimSlashes(path.posix.normalize(p));
  const normal = path.win32.normalize(p);
  const root = path.win32.parse(normal).root;
  return normal.length > root.length ? normal.replace(/\\+$/, "") : normal;
}

/** What of `inner` is inside `outer`, both clean ("" for `outer` itself); undefined when it is not. */
function inside(style: PathStyle, outer: string, inner: string): string | undefined {
  const head = inner.slice(0, outer.length);
  if (style.windows ? head.toLowerCase() !== outer.toLowerCase() : head !== outer) return;
  if (inner.length === outer.length) return "";
  if (outer.endsWith(style.sep)) return inner.slice(outer.length);
  return inner[outer.length] === style.sep ? inner.slice(outer.length + 1) : undefined;
}

/** Whether `inner` is `outer` or inside it, both clean. */
function within(style: PathStyle, outer: string, inner: string): boolean {
  return inside(style, outer, inner) !== undefined;
}

/** `rel` (workspace-relative, "/"-separated) as an absolute path in the workspace's folder. */
function absoluteIn(style: PathStyle, base: string, rel: string): string {
  if (!rel) return base;
  return style.windows ? path.win32.join(base, rel) : `${base}/${rel}`;
}

/**
 * Where `asked` is, or Forbidden when it is outside the workspace's folders.
 * A path inside the workspace's folder is given as relative to it, with "/"
 * between its parts on Windows too; one in a folder a chat was given, as
 * absolute and written as the workspace's folder is.
 */
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

/** Fully qualified paths on the desktop host, without Windows device paths or streams. */
export function absoluteFilePath(asked: string): string {
  const windows = process.platform === "win32";
  if (
    asked.includes("\0") ||
    (windows
      ? !WINDOWS_ABSOLUTE.test(asked) || /^[\\/]{2}[?.][\\/]/.test(asked)
      : !path.isAbsolute(asked))
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

/** Resolve an outside source to the path the user approves. */
export async function outsideFileSource(asked: string): Promise<string> {
  const absolute = absoluteFilePath(asked);
  return nodeFs.realpath(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      throw new RpcFailure(RpcErrorCode.NotFound, `${asked} does not exist`);
    }
    throw new RpcFailure(RpcErrorCode.Unavailable, "the file could not be resolved");
  });
}

/**
 * Where `asked` is, as placeOf finds it; outside the workspace's folders,
 * one of the files its chats name (took, wrote, linked, or a job's output),
 * read by its name wherever a link there leads (`output`), as the chat's
 * previews read it.
 */
async function placeToRead(
  files: RemoteFiles,
  workspaceId: string,
  root: string,
  folders: readonly string[],
  asked: string,
): Promise<Place | { kind: "folder"; absolute: string; output: true }> {
  try {
    return placeOf(root, folders, asked);
  } catch (error) {
    if (!(error instanceof RpcFailure) || error.code !== RpcErrorCode.Forbidden) throw error;
    if (!files.named || asked.includes("\0")) throw error;
    const style = styleOf(root);
    const wanted = clean(style, asked);
    const same = (a: string) =>
      style.windows ? a.toLowerCase() === wanted.toLowerCase() : a === wanted;
    const named = await files.named(workspaceId);
    if (!named.some((o) => same(clean(style, o)))) throw error;
    return { kind: "folder", absolute: wanted, output: true };
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

/**
 * Refuses a path inside the workspace that goes through a link: the agent
 * keeps paths inside the folder by their names only, and follows a link
 * to wherever it points. What the path's last part is, otherwise. `rel`
 * is placeOf's, its parts between "/" on Windows too: the agent there
 * takes "\" as a separator as well, and would pass a link it hid.
 */
async function throughNoLink(fs: FsProvider, rel: string, asked: string) {
  const parts = rel ? rel.split("/") : [];
  let stat = await fs.stat("").catch((error: unknown) => notFound(error, asked));
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    stat = await fs.stat(prefix).catch((error: unknown) => notFound(error, asked));
    if (stat.isSymlink) throw forbidden(`${prefix} is a link: what it points to is not read`);
  }
  return stat;
}

/**
 * Reads the start of a file git does not track yet, as text, for its diff
 * (git.diff): only one in the workspace's folder (`rootOf` names it), and
 * not through a link, which git would show as the path it holds but a read
 * would follow, to a file anywhere (an untracked `key -> ~/.ssh/id_ed25519`).
 */
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
    const provider = await fs(workspaceId);
    await throughNoLink(provider, place.rel, absolute);
    const read = await provider.readRange(place.rel, 0, maxBytes);
    if (read.kind === "missing") return "";
    return new TextDecoder("utf-8").decode(Buffer.from(read.base64, "base64"), { stream: true });
  };
}

/**
 * A folder inside the workspace's own, absolute, for a new chat to run in:
 * Forbidden outside it or through a link, InvalidParams for a file.
 */
export async function folderIn(
  fs: FsProvider | null,
  root: string,
  asked: string,
): Promise<string> {
  const place = placeOf(root, [], asked);
  if (place.kind !== "workspace") throw forbidden(`${asked} is outside the workspace's folder`);
  if (fs) {
    const stat = await throughNoLink(fs, place.rel, asked);
    if (stat.type !== "dir") {
      throw new RpcFailure(RpcErrorCode.InvalidParams, `${asked} is a file, not a folder`);
    }
  }
  const style = styleOf(root);
  return absoluteIn(style, clean(style, root), place.rel);
}

/**
 * Refuses a path in a folder a chat was given whose real place, past its
 * links, is outside the folders given. That is told only on this computer:
 * the agent of a workspace on another host (SSH, WSL) has no way to, and
 * would follow a link out of the folder, so such a folder is not read there.
 */
async function realWithin(
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
  const real = await nodeFs.realpath(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT")
      throw new RpcFailure(RpcErrorCode.NotFound, `${absolute} does not exist`);
    throw new RpcFailure(RpcErrorCode.Unavailable, "the file could not be resolved");
  });
  const reals = await Promise.all(folders.map((f) => nodeFs.realpath(f).catch(() => null)));
  // Resolved names carry their on-disk spelling. Windows can enable
  // case-sensitive lookup on individual folders.
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

/** A folder outside the workspace's, listed on this computer: the agent lists only its workspace's. */
async function listHere(absolute: string): Promise<Entry[]> {
  const dirents = await nodeFs
    .readdir(absolute, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new RpcFailure(RpcErrorCode.NotFound, `${absolute} does not exist`);
      }
      if (error.code === "ENOTDIR") {
        throw new RpcFailure(
          RpcErrorCode.InvalidParams,
          `${absolute} is a file: files.read reads it`,
        );
      }
      throw new RpcFailure(RpcErrorCode.Unavailable, error.message);
    });
  return Promise.all(
    dirents
      .filter((d) => !HIDDEN.has(d.name))
      .map(async (d): Promise<Entry> => {
        if (d.isSymbolicLink()) return { name: d.name, kind: "link" };
        if (d.isDirectory()) return { name: d.name, kind: "dir" };
        const size = await nodeFs
          .stat(path.join(absolute, d.name))
          .then((s) => s.size)
          .catch(() => undefined);
        return { name: d.name, kind: "file", ...(size !== undefined ? { size } : {}) };
      }),
  );
}

export async function listFiles(
  files: RemoteFiles,
  root: string,
  { workspaceId, path: asked, anywhere }: RpcParams<"files.list">,
  approvedPath?: string,
): Promise<RpcResult<"files.list">> {
  const folders = anywhere ? [] : await files.folders(workspaceId);
  const place: Place = anywhere
    ? { kind: "folder", absolute: absoluteFilePath(asked) }
    : placeOf(root, folders, asked);
  const style = styleOf(root);
  const fs = await files.fs(workspaceId);
  let entries: Entry[];
  let absolute: string;
  if (place.kind === "workspace") {
    const stat = await throughNoLink(fs, place.rel, asked);
    if (stat.type !== "dir") {
      throw new RpcFailure(RpcErrorCode.InvalidParams, `${asked} is a file: files.read reads it`);
    }
    entries = (await fs.readdir(place.rel).catch((error: unknown) => notFound(error, asked))).map(
      entryOf,
    );
    absolute = absoluteIn(style, clean(style, root), place.rel);
  } else {
    if (fs.kind !== "local") {
      throw new RpcFailure(
        RpcErrorCode.Unavailable,
        "a folder outside the workspace's is listed only on this computer, not on its host",
      );
    }
    if (!anywhere) await realWithin(fs, style, folders, place.absolute);
    entries = await listHere(approvedPath ?? place.absolute);
    if (approvedPath && (await outsideFileSource(asked)) !== approvedPath) {
      throw fileChanged(false);
    }
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

/** Text from the start of a file's bytes, a character cut at the end left out. */
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
  const place = anywhere
    ? { kind: "folder" as const, absolute: absoluteFilePath(asked) }
    : await placeToRead(files, workspaceId, root, folders, asked);
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
    source = { relPath: place.rel };
    absolute = absoluteIn(style, clean(style, root), place.rel);
  } else {
    absolute = place.absolute;
    source = anywhere
      ? { absolutePath: absolute, ...(approvedPath ? { expectedRealPath: approvedPath } : {}) }
      : "output" in place
        ? { absolutePath: absolute }
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
    // The grant may have been revoked while the workspace's agent was reading.
    const currentFolders = await files.folders(workspaceId);
    const current = await placeToRead(files, workspaceId, root, currentFolders, asked);
    if (current.kind !== "folder" || "output" in current !== "output" in place) {
      throw forbidden(`${asked} no longer has the same file grant`);
    }
    if (
      "expectedRealPath" in source &&
      (await realWithin(fs, style, currentFolders, absolute)) !== source.expectedRealPath
    ) {
      throw fileChanged(requireVersion !== undefined);
    }
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
    // Older filesystem agents cannot safely open an arbitrary path as a regular file.
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
  // An older SSH/WSL agent only has the ordinary reads. Fresh bytes remain
  // available, but cannot satisfy a pin or confirm cached bytes.
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
  // Agent errors can refer to a resolved target or a component of that path.
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
    // A small file can still expand to a large image when decoded.
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
  // Text that escapes long in JSON (quotes, backslashes) may not go in a frame whole.
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
