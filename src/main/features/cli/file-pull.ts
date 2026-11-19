import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import {
  MAX_BYTES_CHUNK,
  RpcErrorCode,
  type RpcResult,
} from "../../../../packages/remote-protocol/src";
import { validFileName, writeFileChunk } from "../remote/file-io";
import { bytesOf, supportsFileVersions } from "../remote/peer-file-reads";
import { type CliContext, CliError } from "./context";
import {
  type FilePeer,
  type FileTransfer,
  fileTransferTarget,
  rpcMessage,
  transferChunks,
  withFileTransfer,
} from "./file-transfer";
import { callerPath } from "./paths";
import { deviceRef } from "./remote";

type Bytes = Omit<Extract<RpcResult<"files.read">, { kind: "bytes" }>, "data"> & { data: Buffer };
type Source =
  | { kind: "file"; remotePath: string }
  | { kind: "link"; remotePath: string }
  | { kind: "dir"; remotePath: string; children: { name: string; source: Source }[] };
type Copy = { path: string; source: Source };

interface SavedFile {
  path: string;
  remotePath: string;
  size: number;
  sha256: string;
}

type PullEntry = SavedFile | { remotePath: string; skipped: "symlink" };

function isFolder(error: unknown): boolean {
  return (
    rpcMessage(error, RpcErrorCode.InvalidParams)?.endsWith("is a folder: files.list lists it") ??
    false
  );
}

function changed(remotePath: string): CliError {
  return new CliError(`${JSON.stringify(remotePath)} changed while copying`);
}

async function readBytes(
  peer: FilePeer,
  request: { path: string; offset: number; length: number; versioned?: true },
  signal: AbortSignal,
  generation?: Bytes,
): Promise<Bytes> {
  const { path: remotePath, offset, length } = request;
  const version = generation?.version;
  let result: RpcResult<"files.read">;
  try {
    result = await peer(
      "files.read",
      {
        ...request,
        as: "bytes",
        ...(version !== undefined ? { requireVersion: version } : {}),
      },
      signal,
    );
  } catch (error) {
    if (
      rpcMessage(error, RpcErrorCode.InvalidParams) === "file version changed" ||
      rpcMessage(error, RpcErrorCode.Unavailable) === "the file changed while it was being read" ||
      (generation && (isFolder(error) || rpcMessage(error, RpcErrorCode.NotFound) !== undefined))
    )
      throw changed(remotePath);
    throw error;
  }
  if (result.kind !== "bytes") {
    throw new CliError('the remote NexusCode does not support files.read as "bytes"', 3);
  }
  if (
    !Number.isSafeInteger(result.size) ||
    (generation &&
      (result.size !== generation.size || (version !== undefined && result.version !== version)))
  )
    throw changed(remotePath);
  try {
    bytesOf(result, offset, length);
  } catch {
    throw changed(remotePath);
  }
  const data = Buffer.from(result.data, "base64");
  if (data.length !== Math.max(0, Math.min(length, result.size - offset))) {
    throw changed(remotePath);
  }
  return { ...result, data };
}

async function listTree(
  peer: FilePeer,
  remotePath: string,
  rules: path.PlatformPath,
  signal: AbortSignal,
): Promise<Source> {
  // Discover truncation anywhere in the tree before creating local entries.
  const listing = await peer("files.list", { path: remotePath }, signal);
  if (listing.truncated) {
    throw new CliError(`directory listing for ${JSON.stringify(listing.path)} is truncated`);
  }
  const children: Extract<Source, { kind: "dir" }>["children"] = [];
  for (const entry of listing.entries) {
    if (!validFileName(entry.name, rules)) {
      throw new CliError(`invalid entry name from the remote: ${JSON.stringify(entry.name)}`);
    }
    const child = rules.join(listing.path, entry.name);
    const source =
      entry.kind === "dir"
        ? await listTree(peer, child, rules, signal)
        : { kind: entry.kind, remotePath: child };
    children.push({ name: entry.name, source });
  }
  return { kind: "dir", remotePath: listing.path, children };
}

async function localIO<T>(destination: string, act: () => Promise<T>): Promise<T> {
  try {
    return await act();
  } catch (error) {
    throw new CliError(`cannot write ${JSON.stringify(destination)}: ${(error as Error).message}`);
  }
}

function localChild(parent: string, name: string): string {
  if (!validFileName(name, path)) {
    throw new CliError(`cannot save the remote name ${JSON.stringify(name)} on this computer`);
  }
  return path.join(parent, name);
}

async function destinationOf(
  ctx: CliContext,
  given: string | undefined,
  sourceName: string,
): Promise<string> {
  if (given === undefined) return localChild(ctx.invocation.cwd, sourceName);
  const destination = callerPath(ctx, given);
  const existing = await localIO(destination, async () => {
    try {
      return await stat(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  });
  return existing?.isDirectory() ? localChild(destination, sourceName) : destination;
}

function planCopies(source: Source, destination: string, copies: Copy[]): void {
  copies.push({ path: destination, source });
  if (source.kind !== "dir") return;
  for (const { name, source: child } of source.children) {
    planCopies(child, child.kind === "link" ? destination : localChild(destination, name), copies);
  }
}

async function makeDirectory(destination: string): Promise<void> {
  try {
    await mkdir(destination);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EEXIST" ||
      !(await lstat(destination)).isDirectory()
    ) {
      throw error;
    }
  }
}

/** Use the current destination's mode when replacing a regular file. */
async function destinationMode(destination: string): Promise<number> {
  try {
    const existing = await lstat(destination);
    if (existing.isFile()) return existing.mode & 0o7777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return 0o666 & ~process.umask();
}

async function copyFile(
  peer: FilePeer,
  remotePath: string,
  destination: string,
  first: Bytes,
  signal: AbortSignal,
): Promise<SavedFile> {
  signal.throwIfAborted();
  const temporary = path.join(path.dirname(destination), `.nexus-pull-${randomUUID()}.tmp`);
  const file = await localIO(destination, () => open(temporary, "wx", 0o600));
  const hash = createHash("sha256");
  let saved = false;
  try {
    try {
      await localIO(destination, () => writeFileChunk(file, first.data, 0));
      hash.update(first.data);
      await transferChunks(
        first.data.length,
        first.size,
        signal,
        async (offset, length, pieceSignal) => {
          const { data } = await readBytes(
            peer,
            { path: remotePath, offset, length },
            pieceSignal,
            first,
          );
          pieceSignal.throwIfAborted();
          await localIO(destination, () => writeFileChunk(file, data, offset));
          return data;
        },
        (bytes) => hash.update(bytes),
      );
      if (first.version === undefined) {
        await readBytes(peer, { path: remotePath, offset: 0, length: 1 }, signal, first);
      }
      signal.throwIfAborted();
      if (process.platform !== "win32") {
        await localIO(destination, async () => file.chmod(await destinationMode(destination)));
      }
    } finally {
      await localIO(destination, () => file.close());
    }
    signal.throwIfAborted();
    await localIO(destination, () => rename(temporary, destination));
    saved = true;
    return {
      path: destination,
      remotePath: first.path,
      size: first.size,
      sha256: hash.digest("hex"),
    };
  } finally {
    if (!saved) await localIO(destination, () => unlink(temporary));
  }
}

export async function pull(
  ctx: CliContext,
  options: {
    device: string;
    workspace?: string;
    remotePath: string;
    localPath?: string;
    recursive: boolean;
  },
): Promise<FileTransfer> {
  return withFileTransfer(ctx, "pull", async (signal) => {
    const { device, rules, peer } = await fileTransferTarget(ctx, options, "pull", signal);
    const versioned = supportsFileVersions(device.schema);
    const readFirst = (remotePath: string) =>
      readBytes(
        peer,
        {
          path: remotePath,
          offset: 0,
          length: MAX_BYTES_CHUNK,
          ...(versioned ? { versioned: true } : {}),
        },
        signal,
      );
    let first: Bytes | undefined;
    let source: Source;
    try {
      first = await readFirst(options.remotePath);
      source = { kind: "file", remotePath: options.remotePath };
    } catch (error) {
      if (!isFolder(error)) throw error;
      if (!options.recursive) {
        throw new CliError(
          `${JSON.stringify(options.remotePath)} is a directory (use -r to copy it)`,
        );
      }
      source = await listTree(peer, options.remotePath, rules, signal);
    }
    const destination = await destinationOf(
      ctx,
      options.localPath,
      rules.basename(first?.path ?? source.remotePath),
    );
    const copies: Copy[] = [];
    planCopies(source, destination, copies);
    const entries: PullEntry[] = [];
    for (const { source: item, path: target } of copies) {
      signal.throwIfAborted();
      if (item.kind === "dir") await localIO(target, () => makeDirectory(target));
      else if (item.kind === "link")
        entries.push({ remotePath: item.remotePath, skipped: "symlink" });
      else {
        const head = first ?? (await readFirst(item.remotePath));
        entries.push(await copyFile(peer, item.remotePath, target, head, signal));
      }
    }
    signal.throwIfAborted();
    return { device: deviceRef(device), destination, entries };
  });
}
