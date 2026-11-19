import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, lstat, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  MAX_BYTES_CHUNK,
  type RemoteWorkspace,
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
} from "../../../../packages/remote-protocol/src";
import { bytesOf, supportsFileVersions } from "../remote/peer-file-reads";
import { RpcFailure } from "../remote/room";
import { type CliContext, type CliDevice, CliError } from "./context";
import { callerPath, onAppMachine } from "./paths";
import {
  askDevice,
  deviceRef,
  offline,
  peerSessions,
  pickPeerWorkspace,
  resolveDevice,
} from "./remote";

type FileMethod = "files.list" | "files.read";
type FilePeer = <M extends FileMethod>(
  method: M,
  params: Omit<RpcParams<M>, "workspaceId">,
  signal: AbortSignal,
) => Promise<RpcResult<M>>;
type Bytes = Extract<RpcResult<"files.read">, { kind: "bytes" }>;
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

const PARALLEL_CHUNKS = 4;
// All pulls share the relay socket with chat and terminal traffic. Allow bursts
// of chunks, with room left in the relay's 50-frame-per-second budget.
const REQUESTS_PER_SECOND = 24;
const sent: number[] = [];
// Leave time to unwind before the hook server (35m) and client (36m) deadlines.
const PULL_TIMEOUT_MS = 34 * 60_000;

async function waitForFileRequest(signal: AbortSignal): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    const now = performance.now();
    while (sent.length > 0 && now - (sent[0] as number) >= 1000) sent.shift();
    if (sent.length < REQUESTS_PER_SECOND) {
      sent.push(now);
      return;
    }
    await delay(Math.ceil(1000 - (now - (sent[0] as number))), undefined, { signal });
  }
}

function rpcMessage(error: unknown, code: number): string | undefined {
  if (error instanceof CliError && error.cause instanceof RpcFailure && error.cause.code === code) {
    return error.cause.message;
  }
}

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
  remotePath: string,
  offset: number,
  length: number,
  signal: AbortSignal,
  generation?: Bytes,
): Promise<Bytes> {
  const version = generation?.version;
  let result: RpcResult<"files.read">;
  try {
    result = await peer(
      "files.read",
      {
        path: remotePath,
        as: "bytes",
        offset,
        length,
        ...(version !== undefined
          ? { requireVersion: version }
          : length === 0
            ? { versioned: true }
            : {}),
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
    return bytesOf(result, offset, length);
  } catch {
    throw changed(remotePath);
  }
}

function validName(name: string, rules: path.PlatformPath): boolean {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("\0") ||
    rules.basename(name) !== name
  ) {
    return false;
  }
  if (rules !== path.win32) return true;
  return (
    !/[<>:"|?*]|[. ]$/.test(name) &&
    !Array.from(name).some((c) => c.charCodeAt(0) < 32) &&
    !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i.test(name)
  );
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
    if (!validName(entry.name, rules)) {
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
  if (!validName(name, path)) {
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

async function writeChunk(file: FileHandle, bytes: Buffer, offset: number): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const { bytesWritten } = await file.write(
      bytes,
      written,
      bytes.length - written,
      offset + written,
    );
    if (bytesWritten === 0) throw new Error("the write made no progress");
    written += bytesWritten;
  }
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
  const stopBatch = new AbortController();
  const pieceSignal = AbortSignal.any([signal, stopBatch.signal]);
  let saved = false;
  try {
    try {
      for (let offset = 0; offset < first.size; ) {
        signal.throwIfAborted();
        const batch: Promise<Buffer>[] = [];
        for (let i = 0; i < PARALLEL_CHUNKS && offset < first.size; i++) {
          const at = offset;
          const length = Math.min(MAX_BYTES_CHUNK, first.size - at);
          batch.push(
            (async () => {
              const piece = await readBytes(peer, remotePath, at, length, pieceSignal, first);
              const bytes = Buffer.from(piece.data, "base64");
              if (bytes.length !== length) throw changed(remotePath);
              pieceSignal.throwIfAborted();
              await localIO(destination, () => writeChunk(file, bytes, at));
              return bytes;
            })(),
          );
          offset += length;
        }
        try {
          for (const bytes of await Promise.all(batch)) hash.update(bytes);
        } catch (error) {
          stopBatch.abort();
          // No positioned write may outlive the file handle or cleanup.
          await Promise.allSettled(batch);
          throw error;
        }
      }
      await readBytes(peer, remotePath, 0, first.version === undefined ? 1 : 0, signal, first);
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

function filePeer(ctx: CliContext, device: CliDevice, workspace: RemoteWorkspace): FilePeer {
  return async <M extends FileMethod>(
    method: M,
    params: Omit<RpcParams<M>, "workspaceId">,
    signal: AbortSignal,
  ) => {
    await waitForFileRequest(signal);
    return askDevice(
      ctx,
      device,
      method,
      { ...params, workspaceId: workspace.id } as RpcParams<M>,
      signal,
    );
  };
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
): Promise<{ device: ReturnType<typeof deviceRef>; destination: string; entries: PullEntry[] }> {
  if (!onAppMachine(ctx)) {
    throw new CliError("run file pull in a local workspace on the app's computer");
  }
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new CliError("file pull timed out", 3)),
    PULL_TIMEOUT_MS,
  );
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline.signal]) : deadline.signal;
  try {
    signal.throwIfAborted();
    const device = await resolveDevice(ctx, options.device);
    if (!device) throw new CliError("give --device to choose a remote computer", 2);
    if (!device.online) throw offline(device, ctx.services.clock.now());
    if (!device.serves.includes("files")) {
      throw new CliError(`"${device.name}" does not share files (Settings › Remote)`);
    }
    const { workspaces } = await peerSessions(ctx, device, signal);
    const workspace = pickPeerWorkspace(device, workspaces, options.workspace);
    const peer = filePeer(ctx, device, workspace);
    // The serving device also accepts UNC paths with forward slashes.
    const rules = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(workspace.path)
      ? path.win32
      : path.posix;
    const metadataLength = supportsFileVersions(device.schema) ? 0 : 1;
    let first: Bytes | undefined;
    let source: Source;
    try {
      first = await readBytes(peer, options.remotePath, 0, metadataLength, signal);
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
        const metadata =
          first ?? (await readBytes(peer, item.remotePath, 0, metadataLength, signal));
        entries.push(await copyFile(peer, item.remotePath, target, metadata, signal));
      }
    }
    signal.throwIfAborted();
    return { device: deviceRef(device), destination, entries };
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
