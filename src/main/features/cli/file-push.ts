import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { MAX_FILE_WRITE_BYTES, RpcErrorCode } from "../../../../packages/remote-protocol/src";
import { readFileChunk, validFileName } from "../remote/file-io";
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

type Copy =
  | { kind: "file"; path: string; remotePath: string; stat: BigIntStats }
  | { kind: "dir"; path: string; remotePath: string }
  | { kind: "link"; path: string; remotePath: string };

function remoteChild(rules: path.PlatformPath, parent: string, name: string): string {
  if (!validFileName(name, rules)) {
    throw new CliError(`cannot save the local name ${JSON.stringify(name)} on the remote computer`);
  }
  return rules.join(parent, name);
}

async function sourceStat(source: string): Promise<BigIntStats> {
  try {
    return await lstat(source, { bigint: true });
  } catch (error) {
    throw new CliError(`cannot read ${JSON.stringify(source)}: ${(error as Error).message}`);
  }
}

async function planCopies(
  copies: Copy[],
  local: string,
  remote: string,
  info: BigIntStats,
  rules: path.PlatformPath,
  recursive: boolean,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (info.isSymbolicLink() && recursive) {
    copies.push({ kind: "link", path: local, remotePath: remote });
  } else if (info.isDirectory()) {
    if (!recursive)
      throw new CliError(`${JSON.stringify(local)} is a directory (use -r to copy it)`);
    copies.push({ kind: "dir", path: local, remotePath: remote });
    for (const name of (await readdir(local)).sort()) {
      const child = path.join(local, name);
      const childInfo = await sourceStat(child);
      const target = childInfo.isSymbolicLink() ? remote : remoteChild(rules, remote, name);
      await planCopies(copies, child, target, childInfo, rules, recursive, signal);
    }
  } else {
    if (!info.isFile()) throw new CliError(`${JSON.stringify(local)} is not a regular file`);
    if (info.size > MAX_FILE_WRITE_BYTES) {
      throw new CliError(
        `${JSON.stringify(local)} exceeds the ${MAX_FILE_WRITE_BYTES} byte upload limit`,
      );
    }
    copies.push({ kind: "file", path: local, remotePath: remote, stat: info });
  }
}

async function remoteDirectory(
  peer: FilePeer,
  remotePath: string,
  signal: AbortSignal,
  writeTarget: boolean,
): Promise<string | undefined> {
  try {
    return (
      await peer(
        "files.list",
        { path: remotePath, ...(writeTarget ? { writeTarget: true } : {}) },
        signal,
      )
    ).path;
  } catch (error) {
    if (
      rpcMessage(error, RpcErrorCode.NotFound) !== undefined ||
      rpcMessage(error, RpcErrorCode.InvalidParams)?.endsWith("is a file: files.read reads it")
    )
      return;
    throw error;
  }
}

function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return (
    after.isFile() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

async function sendFile(
  peer: FilePeer,
  source: Extract<Copy, { kind: "file" }>,
  signal: AbortSignal,
) {
  const file = await open(
    source.path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  const changed = () => new CliError(`${JSON.stringify(source.path)} changed while copying`);
  let uploadId: string | undefined;
  try {
    if (!unchanged(source.stat, await file.stat({ bigint: true }))) throw changed();
    const size = Number(source.stat.size);
    const upload = await peer("files.write.begin", { path: source.remotePath, size }, signal);
    uploadId = upload.uploadId;
    const hash = createHash("sha256");
    await transferChunks(
      0,
      size,
      signal,
      async (offset, length, pieceSignal) => {
        const bytes = await readFileChunk(file, offset, length);
        await peer(
          "files.write.chunk",
          { uploadId: upload.uploadId, offset, data: bytes.toString("base64") },
          pieceSignal,
        );
        return bytes;
      },
      (bytes) => hash.update(bytes),
    );
    if (!unchanged(source.stat, await file.stat({ bigint: true }))) throw changed();
    const sha256 = hash.digest("hex");
    const saved = await peer("files.write.end", { uploadId, sha256 }, signal);
    uploadId = undefined;
    if (saved.size !== size || saved.sha256 !== sha256) {
      throw new CliError("the remote did not confirm the expected file size and SHA-256");
    }
    return { path: source.path, remotePath: saved.path, size, sha256 };
  } finally {
    try {
      await file.close();
    } finally {
      if (uploadId) {
        // The transfer signal may already be cancelled. Still give the host a chance to clean up.
        await peer("files.write.abort", { uploadId }, AbortSignal.timeout(5000)).catch(() => {});
      }
    }
  }
}

export async function push(
  ctx: CliContext,
  options: {
    device: string;
    workspace?: string;
    remotePath: string;
    localPaths: string[];
    recursive: boolean;
  },
): Promise<FileTransfer> {
  return withFileTransfer(ctx, "push", async (signal) => {
    const { device, rules, anywhere, peer } = await fileTransferTarget(
      ctx,
      options,
      "push",
      signal,
    );
    const inspectSources = () =>
      Promise.all(
        options.localPaths.map(async (given) => {
          const local = callerPath(ctx, given);
          return { local, info: await sourceStat(local) };
        }),
      );
    const sources = anywhere && options.recursive ? await inspectSources() : undefined;
    const writeTarget = sources?.some(({ info }) => info.isDirectory()) === true;
    // Use the caller's path spelling to compose children. In workspace mode
    // the host's listing may return a differently spelled absolute root.
    const directory = await remoteDirectory(peer, options.remotePath, signal, writeTarget);
    if (!directory && options.localPaths.length > 1) {
      throw new CliError(
        "the remote destination must be an existing directory for multiple sources",
      );
    }
    const copies: Copy[] = [];
    for (const { local, info } of sources ?? (await inspectSources())) {
      if (
        !directory &&
        !info.isDirectory() &&
        (options.remotePath.endsWith("/") ||
          (rules === path.win32 && options.remotePath.endsWith("\\")))
      ) {
        throw new CliError(
          "the remote destination must be an existing directory when its path ends with a separator",
        );
      }
      const remote = directory
        ? remoteChild(rules, options.remotePath, path.basename(local))
        : options.remotePath;
      await planCopies(copies, local, remote, info, rules, options.recursive, signal);
    }
    const entries: FileTransfer["entries"] = [];
    let destination = directory ?? options.remotePath;
    for (const copy of copies) {
      signal.throwIfAborted();
      if (copy.kind === "link") {
        entries.push({ path: copy.path, skipped: "symlink" });
      } else if (copy.kind === "dir") {
        const created = await peer("files.mkdir", { path: copy.remotePath }, signal);
        if (copy === copies[0] && options.localPaths.length === 1) destination = created.path;
      } else {
        entries.push(await sendFile(peer, copy, signal));
      }
    }
    signal.throwIfAborted();
    return { device: deviceRef(device), destination, entries };
  });
}
