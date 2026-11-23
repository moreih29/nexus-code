import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  stat,
  statfs,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  MAX_BYTES_CHUNK,
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
} from "../../../../packages/remote-protocol/src";
import { createLogger } from "../../../shared/log/main";
import type { AgentFileWrites } from "./agent-file-writes";
import { FILE_WRITE_BUSY, readFileChunk, validFileName, writeFileChunk } from "./file-io";
import { absoluteFilePath, placeOf } from "./files";
import { RpcFailure } from "./room";

const log = createLogger("remote");
const MAX_PER_DEVICE = 4;
const MAX_UPLOADS = 8;
const MAX_ACTIVE_CHUNKS = 4;
const MAX_RANGES = 4096;
const MAX_IDLE_MS = 120_000;
const STALE_TEMP_MS = 24 * 60 * 60_000;
const TEMP_UPLOAD = /^\.nexus-push-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

type Begin = RpcParams<"files.write.begin">;
type Scope = Pick<Begin, "path" | "anywhere">;
type UploadRef = RpcParams<"files.write.abort">;
type UploadResult = RpcResult<"files.write.end">;
type Range = [start: number, end: number];
type Authorize = (destination?: string) => void;

type ScheduleExpiry = (expire: () => Promise<void>, idleMs: number) => () => void;

const scheduleExpiry: ScheduleExpiry = (expire, idleMs) => {
  const timer = setTimeout(() => void expire(), idleMs);
  timer.unref();
  return () => clearTimeout(timer);
};

interface Destination {
  path: string;
  parent: string;
  parentInfo: Stats;
}

interface Upload {
  device: string;
  request: Begin;
  root: string;
  authorize: Authorize;
  controller: AbortController;
  work: Set<Promise<unknown>>;
  ranges: Range[];
  sealed: boolean;
  started: boolean;
  destination?: Destination;
  agent?: { writer: AgentFileWrites; path: string };
  temporary?: string;
  file?: FileHandle;
  fileInfo?: Stats;
  reserved: number;
  cancelExpiry?: () => void;
  cleanup?: Promise<void>;
}

const invalid = (message: string) => new RpcFailure(RpcErrorCode.InvalidParams, message);
const forbidden = (message: string) => new RpcFailure(RpcErrorCode.Forbidden, message);
const busy = () => new RpcFailure(RpcErrorCode.Unavailable, FILE_WRITE_BUSY);

function fileError(error: unknown): never {
  if (error instanceof RpcFailure) throw error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    throw new RpcFailure(RpcErrorCode.NotFound, "the destination's parent folder does not exist");
  }
  if (code === "ENOSPC" || code === "EDQUOT") {
    throw new RpcFailure(RpcErrorCode.Unavailable, "the destination has insufficient disk space");
  }
  if (code === "EACCES" || code === "EPERM") {
    throw forbidden("the destination cannot be written by NexusCode");
  }
  throw error;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function optionalStat(target: string): Promise<Stats | undefined> {
  return lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
}

export function workspaceWritePath(root: string, requested: string, directory: boolean): string {
  const place = placeOf(root, [], requested);
  if (place.kind !== "workspace") throw forbidden("the path is outside the workspace's folder");
  if (!place.rel && !directory) throw invalid("the destination is a folder");
  return place.rel;
}

async function locate(root: string, request: Scope, directory = false): Promise<Destination> {
  let asked: string;
  if (request.anywhere) {
    asked = absoluteFilePath(request.path);
  } else {
    const rel = workspaceWritePath(root, request.path, directory);
    asked = absoluteFilePath(path.join(root, rel));
    if (rel) {
      let prefix = root;
      for (const part of rel.split("/").slice(0, -1)) {
        prefix = path.join(prefix, part);
        if ((await lstat(prefix)).isSymbolicLink()) {
          throw forbidden("the path goes through a symbolic link");
        }
      }
    }
  }
  const workspaceRoot = !request.anywhere && !path.relative(root, asked);
  const parent = await realpath(workspaceRoot ? root : path.dirname(asked));
  if (!request.anywhere) {
    const base = await realpath(root);
    if (base !== parent && !parent.startsWith(base.endsWith(path.sep) ? base : base + path.sep)) {
      throw forbidden("the path leads outside the workspace's folder");
    }
  }
  const name = path.basename(asked);
  if (!validFileName(name, path) && !(directory && asked === path.parse(asked).root)) {
    throw invalid("the destination needs a file name");
  }
  const parentInfo = await stat(parent);
  if (!parentInfo.isDirectory()) throw invalid("the destination's parent is not a folder");
  return { path: workspaceRoot ? parent : path.join(parent, name), parent, parentInfo };
}

export async function fileWriteDestination(
  root: string,
  request: Scope,
  directory: boolean,
): Promise<string> {
  try {
    return (await locate(root, request, directory)).path;
  } catch (error) {
    return fileError(error);
  }
}

async function existingFile(target: string): Promise<Stats | undefined> {
  const current = await optionalStat(target);
  if (current?.isSymbolicLink()) throw forbidden("the destination is a symbolic link");
  if (current && !current.isFile()) throw invalid("the destination is not a regular file");
  return current;
}

function cover(ranges: Range[], start: number, end: number): void {
  const index = ranges.findIndex((range) => range[1] >= start);
  const at = index === -1 ? ranges.length : index;
  const left = ranges[at];
  const next = left?.[1] === start ? ranges[at + 1] : left;
  if (next && next[0] < end) throw invalid("the piece overlaps bytes already received");
  const joinsLeft = left?.[1] === start;
  const joinsRight = next?.[0] === end;
  if (!joinsLeft && !joinsRight && ranges.length >= MAX_RANGES) {
    throw invalid("the upload has too many gaps between pieces");
  }
  ranges.splice(at, Number(joinsLeft) + Number(joinsRight), [
    joinsLeft ? left[0] : start,
    joinsRight ? next[1] : end,
  ]);
}

export async function makeRemoteDirectory(
  root: string,
  request: Scope,
  authorize: Authorize,
): Promise<RpcResult<"files.mkdir">> {
  try {
    const destination = await locate(root, request, true);
    authorize(destination.path);
    try {
      await mkdir(destination.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = await lstat(destination.path);
      if (current.isSymbolicLink()) throw forbidden("the destination is a symbolic link");
      if (!current.isDirectory()) throw invalid("the destination is not a folder");
    }
    return { path: destination.path };
  } catch (error) {
    return fileError(error);
  }
}

async function removeStaleUploads(
  destination: Destination,
  checkDestination: () => Promise<void>,
): Promise<void> {
  const cutoff = Date.now() - STALE_TEMP_MS;
  const target = path.basename(destination.path).toLowerCase();
  try {
    const folder = await opendir(destination.parent);
    for await (const entry of folder) {
      if (entry.name === target || !entry.isFile() || !TEMP_UPLOAD.test(entry.name)) continue;
      const temporary = path.join(destination.parent, entry.name);
      const info = await optionalStat(temporary).catch(() => undefined);
      if (!info?.isFile() || info.mtimeMs >= cutoff) continue;
      await checkDestination();
      const current = await optionalStat(temporary).catch(() => undefined);
      if (current?.isFile() && current.mtimeMs < cutoff && sameFile(info, current)) {
        await unlink(temporary).catch(() => {});
      }
    }
  } catch {}
}

export class FileWrites {
  private readonly uploads = new Map<string, Upload>();

  constructor(private readonly schedule: ScheduleExpiry = scheduleExpiry) {}

  async begin(
    device: string,
    root: string,
    request: Begin,
    authorize: Authorize,
    agent?: Upload["agent"],
  ): Promise<RpcResult<"files.write.begin">> {
    authorize();
    if (
      this.uploads.size >= MAX_UPLOADS ||
      [...this.uploads.values()].filter((upload) => upload.device === device).length >=
        MAX_PER_DEVICE
    ) {
      throw busy();
    }
    const uploadId = randomUUID();
    const upload: Upload = {
      device,
      request,
      root,
      authorize,
      controller: new AbortController(),
      work: new Set(),
      ranges: [],
      sealed: false,
      started: false,
      reserved: 0,
      agent,
    };
    this.uploads.set(uploadId, upload);
    this.touch(uploadId, upload);
    try {
      await this.work(upload, async () => {
        if (agent) {
          authorize(agent.path);
          await agent.writer.begin(uploadId, agent.path, request.size);
          upload.controller.signal.throwIfAborted();
          return;
        }
        const destination = await locate(root, request);
        const checkDestination = async () => {
          await this.verifyParent(root, request, destination);
          upload.controller.signal.throwIfAborted();
          authorize(destination.path);
        };
        await existingFile(destination.path);
        await checkDestination();
        await removeStaleUploads(destination, checkDestination);
        const space = await statfs(destination.parent, { bigint: true });
        const reserved = [...this.uploads.values()]
          .filter((other) => other.destination?.parentInfo.dev === destination.parentInfo.dev)
          .reduce((sum, other) => sum + other.reserved, 0);
        if (BigInt(request.size + reserved) > space.bavail * space.bsize) {
          throw new RpcFailure(
            RpcErrorCode.Unavailable,
            "the destination has insufficient disk space",
          );
        }
        upload.destination = destination;
        upload.reserved = request.size;
        await checkDestination();
        const temporary = path.join(destination.parent, `.nexus-push-${uploadId}.tmp`);
        upload.file = await open(temporary, "wx+", 0o600);
        upload.temporary = temporary;
        upload.fileInfo = await upload.file.stat();
        await this.verifyParent(root, request, destination);
        upload.controller.signal.throwIfAborted();
      });
      upload.started = true;
      return { uploadId };
    } catch (error) {
      await this.discard(uploadId, upload);
      return fileError(error);
    }
  }

  async chunk(device: string, request: RpcParams<"files.write.chunk">): Promise<void> {
    const upload = this.mine(device, request);
    if (upload.sealed || !upload.started) throw invalid("the upload is not accepting pieces");
    if (upload.work.size >= MAX_ACTIVE_CHUNKS) throw busy();
    if (!BASE64.test(request.data)) throw invalid("the piece is not base64");
    const bytes = Buffer.from(request.data, "base64");
    if (
      bytes.length === 0 ||
      bytes.length > MAX_BYTES_CHUNK ||
      bytes.toString("base64") !== request.data
    ) {
      throw invalid("the piece has an invalid length or encoding");
    }
    const end = request.offset + bytes.length;
    if (end > upload.request.size) throw invalid("the piece exceeds the declared file size");
    cover(upload.ranges, request.offset, end);
    this.touch(request.uploadId, upload);
    try {
      await this.work(upload, async () => {
        if (upload.agent) {
          await upload.agent.writer.chunk(request.uploadId, request.offset, request.data);
        } else {
          if (!upload.file) throw invalid("the upload has not started");
          await writeFileChunk(upload.file, bytes, request.offset);
          upload.reserved -= bytes.length;
        }
      });
    } catch (error) {
      await this.discard(request.uploadId, upload);
      return fileError(error);
    }
  }

  async end(device: string, request: RpcParams<"files.write.end">): Promise<UploadResult> {
    const upload = this.mine(device, request);
    const { agent } = upload;
    if (upload.sealed || upload.work.size > 0) throw busy();
    if (!upload.started) throw invalid("the upload has not started");
    upload.sealed = true;
    upload.cancelExpiry?.();
    const signal = upload.controller.signal;
    try {
      return await this.work(upload, async () => {
        const size = upload.request.size;
        if (
          size !== 0 &&
          (upload.ranges.length !== 1 ||
            upload.ranges[0]?.[0] !== 0 ||
            upload.ranges[0][1] !== size)
        ) {
          throw invalid("the upload did not receive all the declared bytes");
        }
        let destination: string;
        if (agent) {
          await agent.writer.verify(request.uploadId, request.sha256, size);
          signal.throwIfAborted();
          upload.authorize(agent.path);
          await agent.writer.commit(request.uploadId);
          delete upload.agent;
          destination = agent.path;
        } else {
          destination = await this.commitLocal(upload, request.sha256);
        }
        const result = { path: destination, size, sha256: request.sha256 };
        log.info(
          `Received remote file ${JSON.stringify({ device, from: upload.request.from, ...result })}`,
        );
        return result;
      });
    } catch (error) {
      return fileError(error);
    } finally {
      await this.discard(request.uploadId, upload);
    }
  }

  private async commitLocal(upload: Upload, sha256: string): Promise<string> {
    const { file, destination, temporary, fileInfo } = upload;
    if (!file || !destination || !temporary || !fileInfo)
      throw invalid("the upload has not started");
    const { size } = upload.request;
    if ((await file.stat()).size !== size) {
      throw invalid("the upload did not receive all the declared bytes");
    }
    const signal = upload.controller.signal;
    const hash = createHash("sha256");
    for (let offset = 0; offset < size; offset += MAX_BYTES_CHUNK) {
      signal.throwIfAborted();
      hash.update(await readFileChunk(file, offset, Math.min(MAX_BYTES_CHUNK, size - offset)));
    }
    if (hash.digest("hex") !== sha256) throw invalid("the upload's SHA-256 did not match");
    await this.verifyParent(upload.root, upload.request, destination);
    const current = await existingFile(destination.path);
    if (process.platform !== "win32") {
      const mode = current ? current.mode & 0o7777 : 0o666 & ~process.umask();
      await file.chmod(mode);
    }
    await file.close();
    delete upload.file;
    await this.verifyParent(upload.root, upload.request, destination);
    if (!sameFile(fileInfo, await lstat(temporary))) {
      throw forbidden("the temporary file changed during the upload");
    }
    signal.throwIfAborted();
    upload.authorize(destination.path);
    await rename(temporary, destination.path);
    delete upload.temporary;
    return destination.path;
  }

  async abort(device: string, request: UploadRef): Promise<void> {
    const upload = this.uploads.get(request.uploadId);
    if (upload?.device !== device) return;
    this.checkScope(upload, request);
    await this.discard(request.uploadId, upload);
  }

  async drop(device?: string): Promise<void> {
    await Promise.all(
      [...this.uploads]
        .filter(([, upload]) => device === undefined || upload.device === device)
        .map(([id, upload]) => this.discard(id, upload)),
    );
  }

  private mine(device: string, request: UploadRef): Upload {
    const upload = this.uploads.get(request.uploadId);
    if (!upload || upload.device !== device || upload.controller.signal.aborted) {
      throw new RpcFailure(RpcErrorCode.NotFound, "no such pending file upload");
    }
    this.checkScope(upload, request);
    upload.authorize();
    return upload;
  }

  private checkScope(upload: Upload, request: UploadRef): void {
    if (request.anywhere && !upload.request.anywhere)
      throw forbidden("the upload's scope cannot change");
  }

  private async verifyParent(root: string, request: Scope, expected: Destination): Promise<void> {
    const current = await locate(root, request);
    if (current.path !== expected.path || !sameFile(current.parentInfo, expected.parentInfo)) {
      throw forbidden("the destination folder changed during the upload");
    }
  }

  private async work<T>(upload: Upload, operation: () => Promise<T>): Promise<T> {
    const pending = operation();
    upload.work.add(pending);
    try {
      return await pending;
    } finally {
      upload.work.delete(pending);
    }
  }

  private touch(id: string, upload: Upload): void {
    upload.cancelExpiry?.();
    upload.cancelExpiry = this.schedule(() => this.discard(id, upload), MAX_IDLE_MS);
  }

  private discard(id: string, upload: Upload): Promise<void> {
    if (upload.cleanup) return upload.cleanup;
    upload.controller.abort(new RpcFailure(RpcErrorCode.Unavailable, "the upload was cancelled"));
    upload.cancelExpiry?.();
    upload.cleanup = (async () => {
      try {
        if (upload.started && upload.agent) {
          const [abort] = await Promise.allSettled([
            upload.agent.writer.abort(id),
            Promise.allSettled(upload.work),
          ]);
          if (abort.status === "rejected") throw abort.reason;
        } else {
          await Promise.allSettled(upload.work);
          await upload.agent?.writer.abort(id);
        }
        try {
          await upload.file?.close();
        } finally {
          if (upload.temporary) {
            const current = await optionalStat(upload.temporary);
            if (current && (!upload.fileInfo || sameFile(upload.fileInfo, current))) {
              await unlink(upload.temporary);
            }
          }
        }
      } catch (error) {
        log.warn(
          `Could not clean up remote file upload ${id} from ${upload.device}: ${String(error)}`,
        );
      } finally {
        this.uploads.delete(id);
      }
    })();
    return upload.cleanup;
  }
}
