import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { CustomScheme } from "electron";
import * as electron from "electron";
import { MAX_BYTES_CHUNK } from "../../../../packages/remote-protocol/src";
import { READ_RANGE_MAX_BYTES } from "../../../shared/fs/defaults";
import { outsideWorkspaceOf } from "../../../shared/fs/outside-url";
import { PEER_HOST, type PeerWorkspace, peerFileOf, peerOf } from "../../../shared/fs/peer-url";
import type { FileReadBinaryResult } from "../../../shared/fs/types";
import { createLogger } from "../../../shared/log/main";
import { scopedSegments, scopeIdOf } from "../../../shared/preview/scope-url";
import { isOutsideGranted, resolveOutsideGrant } from "../fs/outside-grants";
import { isGuardedPeerViewFile } from "../fs/read-guard";
import type { WorkspaceManager } from "../workspace/manager";
import { type PreviewScope, type PreviewScopes, realpathNative } from "./preview-scopes";

const logger = createLogger("nexus-workspace");

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
};

function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? "application/octet-stream";
}

function responseHeaders(filePath: string, readable = false): Record<string, string> {
  return {
    "Content-Type": mimeFromPath(filePath),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
    ...(readable ? { "Access-Control-Allow-Origin": "*" } : {}),
  };
}

function readableBy(response: Response): Response {
  if (response.ok) response.headers.set("Access-Control-Allow-Origin", "*");
  return response;
}

function joinScoped(dir: string, segments: readonly string[]): string {
  return dir === "/" || /^[A-Za-z]:\/?$/.test(dir)
    ? `${dir.replace(/\/?$/, "/")}${segments.join("/")}`
    : `${dir}/${segments.join("/")}`;
}

function comparablePath(p: string): string {
  return process.platform === "win32" ? p.replace(/\\/g, "/").toLowerCase() : p;
}

export async function realScopedPath(dir: string, target: string): Promise<string | null> {
  try {
    const [realDir, real] = await Promise.all([realpathNative(dir), realpathNative(target)]);
    const base = comparablePath(realDir).replace(/\/+$/, "");
    const inside = comparablePath(real);
    return inside.startsWith(`${base}/`) ? real : null;
  } catch {
    return null;
  }
}

async function serveScoped(
  workspaceManager: WorkspaceManager,
  peers: (() => PeerFileReader | null) | undefined,
  scope: PreviewScope,
  segments: readonly string[],
  req: Request,
): Promise<Response> {
  const target = joinScoped(scope.dir, segments);
  const peer = peerOf(scope.workspaceId);
  if (peer) {
    const reader = peers?.() ?? null;
    if (!reader) return new Response(null, { status: 404 });
    return readableBy(await servePeerFile(reader, peer, target, req));
  }
  const meta = workspaceManager.list().find((m) => m.id === scope.workspaceId);
  if (!meta) return new Response(null, { status: 404 });
  if (meta.location.kind !== "local") {
    const root = meta.location.remotePath.replace(/\/+$/, "");
    const rel = target.startsWith(`${root}/`) ? target.slice(root.length + 1) : target;
    return readableBy(
      await serveViaAgent(workspaceManager, scope.workspaceId, rel, req.headers.get("range")),
    );
  }
  const real = await realScopedPath(scope.dir, target);
  if (!real) {
    logger.warn(`Scoped path left its folder: ${req.url}`);
    return new Response(null, { status: 404 });
  }
  return serveLocalFile(real, req.headers.get("range"), true);
}

export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

export function requestedRange(
  header: string | null,
  size: number,
): ByteRange | "unsatisfiable" | null {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const [, from = "", to = ""] = match;
  if (from === "" && to === "") return null;
  if (size === 0) return "unsatisfiable";
  if (from === "") {
    const length = Number(to);
    if (length === 0) return "unsatisfiable";
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(from);
  if (start >= size) return "unsatisfiable";
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  if (end < start) return null;
  return { start, end };
}

function partialResponse(
  body: ConstructorParameters<typeof Response>[0],
  range: ByteRange,
  size: number,
  filePath: string,
): Response {
  return new Response(body, {
    status: 206,
    headers: {
      ...responseHeaders(filePath),
      "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
      "Content-Length": String(range.end - range.start + 1),
    },
  });
}

function unsatisfiable(size: number): Response {
  return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
}

interface PeerPiece {
  data: string;
  size: number;
  version?: string;
}

export type PeerFileReader = (
  peer: PeerWorkspace,
  absPath: string,
  offset: number,
  length: number,
  signal: AbortSignal,
) => Promise<
  | {
      first: PeerPiece;
      read(offset: number, length: number): Promise<PeerPiece>;
      signal?: AbortSignal;
    }
  | "missing"
>;

export const PEER_PIECE_BYTES = MAX_BYTES_CHUNK;

export function buildNexusWorkspaceHandler(
  workspaceManager: WorkspaceManager,
  peers?: () => PeerFileReader | null,
  scopes?: PreviewScopes,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    let parsed: URL;
    try {
      parsed = new URL(req.url);
    } catch {
      logger.warn(`Invalid URL rejected: ${req.url}`);
      return new Response(null, { status: 404 });
    }

    const scopeId = scopeIdOf(parsed.host);
    if (scopeId !== null) {
      const scope = scopes?.get(scopeId);
      const scoped = scopedSegments(parsed.pathname);
      if (!scope || !scoped || scoped.length === 0) return new Response(null, { status: 404 });
      return serveScoped(workspaceManager, peers, scope, scoped, req);
    }

    const outsideOf = outsideWorkspaceOf(parsed.host);
    const workspaceId = outsideOf ?? parsed.host;
    let segments: string[];
    try {
      segments = parsed.pathname.slice(1).split("/").map(decodeURIComponent);
    } catch {
      return new Response(null, { status: 404 });
    }
    const relPath = segments.join(path.sep);

    if (parsed.host === PEER_HOST) {
      const file = peerFileOf(segments);
      const reader = peers?.() ?? null;
      if (!file || !reader) return new Response(null, { status: 404 });
      return servePeerFile(reader, file.peer, file.absPath, req);
    }

    const metas = workspaceManager.list();
    const meta = metas.find((m) => m.id === workspaceId);
    if (!meta) {
      logger.warn(`Workspace not found: ${workspaceId}`);
      return new Response(null, { status: 404 });
    }

    if (outsideOf !== null) {
      const fromDrive =
        meta.location.kind === "local" &&
        process.platform === "win32" &&
        /^[A-Za-z]:$/.test(segments[0] ?? "");
      const absPath = fromDrive ? segments.join("/") : `/${segments.join("/")}`;
      if (meta.location.kind !== "local") {
        if (!isOutsideGranted(workspaceId, absPath)) {
          logger.warn(`Outside path not granted: ${req.url}`);
          return new Response(null, { status: 404 });
        }
        return serveViaAgent(workspaceManager, workspaceId, absPath, req.headers.get("range"));
      }
      const realPath = await resolveOutsideGrant(workspaceId, absPath);
      if (!realPath) {
        logger.warn(`Outside path not granted: ${req.url}`);
        return new Response(null, { status: 404 });
      }
      return serveLocalFile(realPath, req.headers.get("range"));
    }

    if (meta.location.kind !== "local" || isGuardedPeerViewFile(workspaceId, relPath)) {
      return serveViaAgent(workspaceManager, workspaceId, relPath, req.headers.get("range"));
    }

    const rootPath = path.resolve(meta.location.rootPath);

    const resolved = path.resolve(rootPath, relPath);
    const rootNorm = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep;
    if (resolved !== rootPath && !resolved.startsWith(rootNorm)) {
      logger.warn(`Path traversal attempt rejected: ${req.url}`);
      return new Response(null, { status: 404 });
    }

    let realPath: string;
    try {
      realPath = await fs.promises.realpath(resolved);
    } catch {
      logger.warn(`File not found or inaccessible: ${resolved}`);
      return new Response(null, { status: 404 });
    }

    const realRootNorm = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep;
    let realRoot: string;
    try {
      realRoot = await fs.promises.realpath(rootPath);
    } catch {
      logger.warn(`Workspace root not accessible: ${rootPath}`);
      return new Response(null, { status: 404 });
    }
    const realRootResolved = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;

    if (
      realPath !== realRoot &&
      !realPath.startsWith(realRootResolved) &&
      !realPath.startsWith(realRootNorm)
    ) {
      logger.warn(`Symlink escape rejected: ${realPath}`);
      return new Response(null, { status: 404 });
    }

    return serveLocalFile(realPath, req.headers.get("range"));
  };
}

async function serveLocalFile(
  realPath: string,
  rangeHeader: string | null,
  readable = false,
): Promise<Response> {
  if (rangeHeader !== null) {
    try {
      const { size } = await fs.promises.stat(realPath);
      const range = requestedRange(rangeHeader, size);
      if (range === "unsatisfiable") return unsatisfiable(size);
      if (range !== null) {
        const stream = fs.createReadStream(realPath, { start: range.start, end: range.end });
        const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
        return readable
          ? readableBy(partialResponse(body, range, size, realPath))
          : partialResponse(body, range, size, realPath);
      }
    } catch (err) {
      logger.warn(`Failed to read file: ${realPath} — ${(err as Error).message}`);
      return new Response(null, { status: 404 });
    }
  }

  try {
    const stat = await fs.promises.stat(realPath);
    if (!stat.isFile()) {
      logger.warn(`Not a file: ${realPath}`);
      return new Response(null, { status: 404 });
    }
    const body = Readable.toWeb(fs.createReadStream(realPath)) as ReadableStream<Uint8Array>;
    return new Response(body, { status: 200, headers: responseHeaders(realPath, readable) });
  } catch (err) {
    logger.warn(`Failed to read file: ${realPath} — ${(err as Error).message}`);
    return new Response(null, { status: 404 });
  }
}

const READ_AHEAD = 2;

type PieceReader = (offset: number, length: number) => Promise<FileReadBinaryResult>;

function rangeStart(header: string | null): number {
  const from = header?.trim().match(/^bytes=(\d+)-\d*$/)?.[1];
  return from === undefined ? 0 : Number(from);
}

function pieceBytes(
  result: FileReadBinaryResult,
  length: number,
  mtime: string,
  filePath: string,
): Buffer {
  if (result.kind !== "ok" || result.mtime !== mtime) {
    throw new Error(`${filePath} changed while it was read`);
  }
  const bytes = Buffer.from(result.base64, "base64");
  if (bytes.length !== length) throw new Error(`${filePath} changed while it was read`);
  return bytes;
}

function piecesStream(
  read: PieceReader,
  span: ByteRange,
  head: Buffer,
  mtime: string,
  filePath: string,
  pieceSize: number = READ_RANGE_MAX_BYTES,
  lifetime?: { signal: AbortSignal; cancel(): void },
): ReadableStream<Uint8Array> {
  const end = span.end + 1;
  const first = head.subarray(0, Math.min(head.length, end - span.start));
  const pending: Promise<Buffer>[] = [Promise.resolve(first)];
  let next = span.start + first.length;
  const request = () => {
    const offset = next;
    const length = Math.min(pieceSize, end - offset);
    next += length;
    const piece = read(offset, length).then((result) =>
      pieceBytes(result, length, mtime, filePath),
    );
    piece.catch(() => {});
    pending.push(piece);
  };
  let detachAbort = () => {};
  const stop = () => {
    detachAbort();
    next = end;
    pending.length = 0;
    lifetime?.cancel();
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        if (!lifetime) return;
        const { signal } = lifetime;
        const aborted = () => {
          stop();
          controller.error(signal.reason);
        };
        if (signal.aborted) aborted();
        else {
          signal.addEventListener("abort", aborted, { once: true });
          detachAbort = () => signal.removeEventListener("abort", aborted);
        }
      },
      async pull(controller) {
        try {
          lifetime?.signal.throwIfAborted();
          while (pending.length <= READ_AHEAD && next < end) request();
          const piece = pending.shift();
          if (piece) {
            const bytes = await piece;
            lifetime?.signal.throwIfAborted();
            controller.enqueue(new Uint8Array(bytes));
          }
          if (pending.length === 0 && next >= end) {
            detachAbort();
            controller.close();
          }
        } catch (error) {
          stop();
          throw error;
        }
      },
      cancel: stop,
    },
    lifetime ? { highWaterMark: 0 } : undefined,
  );
}

async function serveViaAgent(
  workspaceManager: WorkspaceManager,
  workspaceId: string,
  relPath: string,
  rangeHeader: string | null,
): Promise<Response> {
  const posixRelPath = relPath.split(path.sep).join("/");
  const outside = posixRelPath.startsWith("/");
  let fsProvider: Awaited<ReturnType<WorkspaceManager["getFs"]>>;
  try {
    fsProvider = await workspaceManager.getFs(workspaceId);
  } catch (err) {
    logger.warn(`SSH workspace fs unavailable: ${workspaceId} — ${(err as Error).message}`);
    return new Response(null, { status: 503 });
  }
  const guarded = !outside && isGuardedPeerViewFile(workspaceId, posixRelPath);
  const read: PieceReader = (offset, length) => {
    if (outside) return fsProvider.readAbsoluteRange(posixRelPath, offset, length);
    if (guarded) {
      if (!fsProvider.readRangeNoLinks) throw new Error("secure file reads are unavailable");
      return fsProvider.readRangeNoLinks(posixRelPath, offset, length);
    }
    return fsProvider.readRange(posixRelPath, offset, length);
  };

  try {
    return await servePieces(read, posixRelPath, rangeHeader, READ_RANGE_MAX_BYTES);
  } catch (err) {
    logger.warn(`SSH readRange failed: ${workspaceId}:${posixRelPath} — ${(err as Error).message}`);
    return new Response(null, { status: 404 });
  }
}

async function servePieces(
  read: PieceReader,
  filePath: string,
  rangeHeader: string | null,
  pieceSize: number,
): Promise<Response> {
  const start = rangeStart(rangeHeader);
  const first = await read(start, pieceSize);
  return serveOpenedPieces(read, filePath, rangeHeader, pieceSize, start, first);
}

async function serveOpenedPieces(
  read: PieceReader,
  filePath: string,
  rangeHeader: string | null,
  pieceSize: number,
  start: number,
  first: FileReadBinaryResult,
  lifetime?: { signal: AbortSignal; cancel(): void },
): Promise<Response> {
  if (first.kind === "missing") return new Response(null, { status: 404 });
  const size = first.sizeBytes;
  const range = requestedRange(rangeHeader, size);
  if (range === "unsatisfiable") return unsatisfiable(size);
  const span = range ?? { start: 0, end: size - 1 };
  if (span.start !== start || (first.base64 === "" && span.start < size)) {
    first = await read(span.start, Math.min(pieceSize, span.end - span.start + 1));
    if (first.kind === "missing") return new Response(null, { status: 404 });
  }
  const body = piecesStream(
    read,
    span,
    Buffer.from(first.base64, "base64"),
    first.mtime,
    filePath,
    pieceSize,
    lifetime,
  );
  if (range !== null) return partialResponse(body, range, size, filePath);
  return new Response(body, {
    status: 200,
    headers: { ...responseHeaders(filePath), "Content-Length": String(size) },
  });
}

async function servePeerFile(
  reader: PeerFileReader,
  peer: PeerWorkspace,
  absPath: string,
  req: Request,
): Promise<Response> {
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, req.signal]);
  try {
    const rangeHeader = req.headers.get("range");
    const start = rangeStart(rangeHeader);
    const to = rangeHeader?.trim().match(/^bytes=\d+-(\d+)$/)?.[1];
    const end = to === undefined ? undefined : Number(to);
    const length = /^bytes=-\d+$/.test(rangeHeader?.trim() ?? "")
      ? 0
      : end !== undefined && end >= start
        ? Math.min(PEER_PIECE_BYTES, end - start + 1)
        : PEER_PIECE_BYTES;
    const opened = await reader(peer, absPath, start, length, signal);
    if (opened === "missing") return new Response(null, { status: 404 });
    const lifetime = {
      signal: opened.signal ? AbortSignal.any([signal, opened.signal]) : signal,
      cancel: () => abort.abort(),
    };
    const adapt = (piece: PeerPiece): FileReadBinaryResult => ({
      kind: "ok",
      base64: piece.data,
      sizeBytes: piece.size,
      mtime: piece.version ?? `size:${piece.size}`,
    });
    lifetime.signal.throwIfAborted();
    return await serveOpenedPieces(
      async (offset, count) => adapt(await opened.read(offset, count)),
      absPath,
      rangeHeader,
      PEER_PIECE_BYTES,
      start,
      adapt(opened.first),
      lifetime,
    );
  } catch (err) {
    abort.abort();
    logger.warn(`peer read failed: ${peer.deviceId}:${absPath} — ${(err as Error).message}`);
    return new Response(null, { status: 404 });
  }
}

export const NEXUS_WORKSPACE_SCHEME: CustomScheme = {
  scheme: "nexus-workspace",
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    bypassCSP: false,
    stream: true,
  },
};

export function installNexusWorkspaceProtocol(
  workspaceManager: WorkspaceManager,
  peers?: () => PeerFileReader | null,
  scopes?: PreviewScopes,
): void {
  electron.protocol.handle(
    "nexus-workspace",
    buildNexusWorkspaceHandler(workspaceManager, peers, scopes),
  );
}
