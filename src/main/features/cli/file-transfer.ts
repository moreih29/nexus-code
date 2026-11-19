import { randomUUID } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  type AgentSender,
  MAX_BYTES_CHUNK,
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
} from "../../../../packages/remote-protocol/src";
import { speaks } from "../../../shared/remote/room";
import { FILE_WRITE_BUSY, filePathRules } from "../remote/file-io";
import { RpcFailure } from "../remote/room";
import { type CliContext, type CliDevice, CliError, type CliRemote } from "./context";
import { onAppMachine } from "./paths";
import {
  agentSenderOf,
  askDevice,
  deviceRef,
  offline,
  peerSessions,
  pickPeerWorkspace,
  resolveDevice,
} from "./remote";

type FileMethod =
  | "files.list"
  | "files.read"
  | "files.mkdir"
  | "files.write.begin"
  | "files.write.chunk"
  | "files.write.end"
  | "files.write.abort";
type FilePeerParams<M extends FileMethod> = Omit<RpcParams<M>, "workspaceId" | "from" | "anywhere">;
export type FilePeer = <M extends FileMethod>(
  method: M,
  params: FilePeerParams<M>,
  signal: AbortSignal,
) => Promise<RpcResult<M>>;

function outsideWorkspaceError(device: CliDevice): CliError {
  return new CliError(
    `"${device.name}" cannot serve file access outside the workspace. Update NexusCode there and enable terminal control (Settings › Remote)`,
    3,
    { error: "outside-workspace", device: deviceRef(device) },
  );
}

export interface FileTransfer {
  device: ReturnType<typeof deviceRef>;
  destination: string;
  entries: Array<
    | { path: string; remotePath: string; size: number; sha256: string }
    | { path?: string; remotePath?: string; skipped: "symlink" }
  >;
}

const PARALLEL_CHUNKS = 4;
const BUSY_RETRIES = 5;
const BUSY_RETRY_BASE_MS = 250;
// Leave room for chats and terminals on the relay's 50-frame-per-second budget.
const REQUESTS_PER_SECOND = 24;
// Pulls and pushes on the same app connection share its request budget.
const sentByRemote = new WeakMap<CliRemote, number[]>();
// Leave time to unwind before the hook server (35m) and client (36m) deadlines.
const TRANSFER_TIMEOUT_MS = 34 * 60_000;

async function waitForFileRequest(sent: number[], signal: AbortSignal): Promise<void> {
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

export function rpcMessage(error: unknown, code: number): string | undefined {
  if (error instanceof CliError && error.cause instanceof RpcFailure && error.cause.code === code) {
    return error.cause.message;
  }
}

/** Process up to four pieces together, reporting them in offset order for hashing. */
export async function transferChunks(
  start: number,
  size: number,
  signal: AbortSignal,
  transfer: (offset: number, length: number, signal: AbortSignal) => Promise<Buffer>,
  received: (bytes: Buffer) => void,
): Promise<void> {
  const controller = new AbortController();
  const pieceSignal = AbortSignal.any([signal, controller.signal]);
  for (let offset = start; offset < size; ) {
    signal.throwIfAborted();
    const batch: Promise<Buffer>[] = [];
    for (let i = 0; i < PARALLEL_CHUNKS && offset < size; i++) {
      const length = Math.min(MAX_BYTES_CHUNK, size - offset);
      batch.push(transfer(offset, length, pieceSignal));
      offset += length;
    }
    try {
      for (const bytes of await Promise.all(batch)) received(bytes);
    } catch (error) {
      controller.abort();
      // A positioned operation must finish before its file handle is closed.
      await Promise.allSettled(batch);
      throw error;
    }
  }
}

export async function withFileTransfer<T>(
  ctx: CliContext,
  verb: "pull" | "push",
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!onAppMachine(ctx)) {
    throw new CliError(`run file ${verb} in a local workspace on the app's computer`);
  }
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new CliError(`file ${verb} timed out`, 3)),
    TRANSFER_TIMEOUT_MS,
  );
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline.signal]) : deadline.signal;
  try {
    signal.throwIfAborted();
    return await run(signal);
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function outsideWorkspace(rules: path.PlatformPath, root: string, asked: string): boolean {
  const absolute =
    rules === path.win32 ? /^[A-Za-z]:[\\/]|^[\\/]{2}[^\\/]/.test(asked) : rules.isAbsolute(asked);
  if (!absolute) return false;
  const relative = rules.relative(root, asked);
  return relative === ".." || relative.startsWith(`..${rules.sep}`) || rules.isAbsolute(relative);
}

function filePeer(
  ctx: CliContext,
  device: CliDevice,
  workspaceId: string,
  anywhere: boolean,
): FilePeer {
  const current = speaks(device.schema, "0.14.0");
  let sender: Promise<AgentSender> | undefined;
  const remote = ctx.services.remote;
  const previous = sentByRemote.get(remote);
  const sent = previous ?? [];
  if (!previous) sentByRemote.set(remote, sent);
  const transferId = current ? randomUUID() : undefined;
  return async <M extends FileMethod>(
    method: M,
    params: FilePeerParams<M>,
    signal: AbortSignal,
  ) => {
    const continuation =
      method === "files.write.chunk" ||
      method === "files.write.end" ||
      method === "files.write.abort";
    if (current) sender ??= agentSenderOf(ctx);
    const request = {
      ...params,
      ...(!continuation ? { workspaceId, ...(transferId ? { transferId } : {}) } : {}),
      ...(sender ? { from: await sender } : {}),
      ...(anywhere ? { anywhere: true } : {}),
    } as RpcParams<M>;
    for (let retry = 0; ; retry++) {
      await waitForFileRequest(sent, signal);
      try {
        return await askDevice(ctx, device, method, request, signal);
      } catch (error) {
        const refusal = rpcMessage(error, RpcErrorCode.Forbidden);
        if (
          anywhere &&
          !current &&
          refusal &&
          /outside the workspace|goes through a link/.test(refusal)
        ) {
          throw outsideWorkspaceError(device);
        }
        const failure = rpcMessage(error, RpcErrorCode.Unavailable);
        if (
          retry >= BUSY_RETRIES ||
          (failure !== FILE_WRITE_BUSY &&
            !(method === "files.read" && failure === "the host is busy reading files"))
        )
          throw error;
      }
      await delay(BUSY_RETRY_BASE_MS * 2 ** retry, undefined, { signal });
    }
  };
}

export async function fileTransferTarget(
  ctx: CliContext,
  options: { device: string; workspace?: string; remotePath: string },
  verb: "pull" | "push",
  signal: AbortSignal,
) {
  const device = await resolveDevice(ctx, options.device);
  if (!device) throw new CliError("give --device to choose a remote computer", 2);
  if (!device.online) throw offline(device, ctx.services.clock.now());
  const current = speaks(device.schema, "0.14.0");
  if (verb === "push" && !current) {
    throw new CliError(
      `"${device.name}" runs an older NexusCode. Update it to use file push (remote protocol 0.14.0 or later)`,
      3,
      { error: "older", device: deviceRef(device), method: "files.write.begin" },
    );
  }
  if (!device.serves.includes("files")) {
    throw new CliError(`"${device.name}" does not share files (Settings › Remote)`);
  }
  const { workspaces } = await peerSessions(ctx, device, signal);
  const workspace = pickPeerWorkspace(device, workspaces, options.workspace);
  const rules = filePathRules(workspace.path);
  const anywhere = outsideWorkspace(rules, workspace.path, options.remotePath);
  if (anywhere && !device.serves.includes("terminal.control")) {
    if (!current) throw outsideWorkspaceError(device);
    throw new CliError(
      `"${device.name}" requires terminal control for file access outside the workspace (Settings › Remote)`,
    );
  }
  if (verb === "push" && !anywhere && !device.serves.includes("files.write")) {
    throw new CliError(
      `"${device.name}" requires chat control and agent access for workspace file writes (Settings › Remote)`,
    );
  }
  return { device, rules, anywhere, peer: filePeer(ctx, device, workspace.id, anywhere) };
}
