import type { FileHandle } from "node:fs/promises";
import path from "node:path";

export function isFileTransferMethod(method: string): boolean {
  return (
    method === "files.read" ||
    method === "files.list" ||
    method === "files.mkdir" ||
    method.startsWith("files.write.")
  );
}

export function needsFileConsent(method: string, params: { anywhere?: true }): boolean {
  return (
    method === "files.write.begin" ||
    method === "files.mkdir" ||
    (params.anywhere === true && (method === "files.read" || method === "files.list"))
  );
}

export const FILE_WRITE_BUSY = "the host is busy writing files";

export function fileVerifyTimeoutMs(size: number): number {
  return 30_000 + Math.ceil((size * 1000) / (32 * 1024 ** 2));
}

export function filePathRules(root: string): path.PlatformPath {
  return /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(root) ? path.win32 : path.posix;
}

export function validFileName(name: string, rules: path.PlatformPath): boolean {
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

export async function writeFileChunk(
  file: FileHandle,
  bytes: Buffer,
  offset: number,
): Promise<void> {
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

export async function readFileChunk(
  file: FileHandle,
  offset: number,
  length: number,
): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await file.read(bytes, read, length - read, offset + read);
    if (bytesRead === 0) throw new Error("the file ended before the expected size");
    read += bytesRead;
  }
  return bytes;
}
