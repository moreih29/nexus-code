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
import type { DirEntry } from "../../../shared/fs/types";
import type { FsProvider } from "../fs/bridge/provider";
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
): Promise<void> {
  if (fs.kind !== "local") {
    throw new RpcFailure(
      RpcErrorCode.Unavailable,
      "a folder outside the workspace's is read only on this computer, not on its host",
    );
  }
  const real = await nodeFs.realpath(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT")
      throw new RpcFailure(RpcErrorCode.NotFound, `${absolute} does not exist`);
    throw new RpcFailure(RpcErrorCode.Unavailable, error.message);
  });
  const reals = await Promise.all(folders.map((f) => nodeFs.realpath(f).catch(() => f)));
  if (!reals.some((f) => within(style, clean(style, f), clean(style, real)))) {
    throw forbidden(`${absolute} leads outside the workspace's folders`);
  }
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
  { workspaceId, path: asked }: RpcParams<"files.list">,
): Promise<RpcResult<"files.list">> {
  const folders = await files.folders(workspaceId);
  const place = placeOf(root, folders, asked);
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
    await realWithin(fs, style, folders, place.absolute);
    entries = await listHere(place.absolute);
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
  }: RpcParams<"files.read">,
): Promise<RpcResult<"files.read">> {
  if (as !== "bytes" && (offset !== undefined || length !== undefined)) {
    throw new RpcFailure(
      RpcErrorCode.InvalidParams,
      'offset and length are taken with as: "bytes"',
    );
  }
  const folders = await files.folders(workspaceId);
  const place = placeOf(root, folders, asked);
  const style = styleOf(root);
  const fs = await files.fs(workspaceId);
  let absolute: string;
  let size: number | undefined;
  if (place.kind === "workspace") {
    if (!place.rel)
      throw new RpcFailure(
        RpcErrorCode.InvalidParams,
        "that is the workspace's folder: files.list lists it",
      );
    const stat = await throughNoLink(fs, place.rel, asked);
    if (stat.type === "dir") {
      throw new RpcFailure(RpcErrorCode.InvalidParams, `${asked} is a folder: files.list lists it`);
    }
    size = stat.size;
    absolute = absoluteIn(style, clean(style, root), place.rel);
  } else {
    await realWithin(fs, style, folders, place.absolute);
    absolute = place.absolute;
  }
  const range = (length: number, from = 0) =>
    (place.kind === "workspace"
      ? fs.readRange(place.rel, from, length)
      : fs.readAbsoluteRange(place.absolute, from, length)
    ).catch((error: unknown) => notFound(error, asked));

  if (as === "bytes") {
    const from = offset ?? 0;
    const read = await range(length ?? MAX_BYTES_CHUNK, from);
    if (read.kind === "missing")
      throw new RpcFailure(RpcErrorCode.NotFound, `${asked} does not exist`);
    return { kind: "bytes", path: absolute, data: read.base64, offset: from, size: read.sizeBytes };
  }

  const mediaType = IMAGE_TYPES[style.path.extname(absolute).toLowerCase()];
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
      if (whole.base64.length <= IMAGE_CHARS) {
        return { kind: "image", path: absolute, mediaType, data: whole.base64, size: total };
      }
      const shrunk = files.shrink(Buffer.from(whole.base64, "base64"), IMAGE_CHARS);
      if (shrunk) return { kind: "image", path: absolute, ...shrunk, size: total };
    }
    return { kind: "binary", path: absolute, size: total };
  }

  const read = await range(maxBytes);
  if (read.kind === "missing")
    throw new RpcFailure(RpcErrorCode.NotFound, `${asked} does not exist`);
  const bytes = Buffer.from(read.base64, "base64");
  const total = size ?? read.sizeBytes;
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
