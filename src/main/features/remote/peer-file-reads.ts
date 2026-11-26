import {
  MAX_BYTES_CHUNK,
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
} from "../../../../packages/remote-protocol/src";
import { createAbortError, isAbortError, throwIfAborted } from "../../../shared/abort";
import type { PeerWorkspace } from "../../../shared/fs/peer-url";
import { type RoomState, speaks } from "../../../shared/remote/room";
import { FILE_GRANTS, grantFailure, type PeerFileGrants } from "./peer-file-grants";
import { RpcFailure } from "./room";

type Params = RpcParams<"files.read">;
type Result = RpcResult<"files.read">;
type Content = Exclude<Result, { kind: "notModified" }>;
type Bytes = Extract<Content, { kind: "bytes" }>;
type Shape = Pick<Params, "as" | "offset" | "length" | "maxBytes">;

interface OpenBytes {
  first: Bytes;
  signal: AbortSignal;
  read(offset: number, length: number): Promise<Bytes>;
}

const CACHE_BYTES = 32 * 1024 * 1024;
const CACHE_ENTRIES = 256;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING = 64;
const MAX_WHOLE_READS = 4;
const MAX_SPAN_READS = 32;
export function supportsFileVersions(schema: string | undefined): boolean {
  return speaks(schema, "0.13.4");
}

interface Entry {
  file: string;
  result: Content;
  cost: number;
}

interface Flight {
  file: string;
  controller: AbortController;
  promise: Promise<Content>;
  waiters: number;
}

function unavailable(message: string): RpcFailure {
  return new RpcFailure(RpcErrorCode.Unavailable, message);
}

function changed(): RpcFailure {
  return new RpcFailure(RpcErrorCode.InvalidParams, "file version changed");
}

export function bytesOf(result: Result, offset: number, length: number): Bytes {
  if (
    result.kind !== "bytes" ||
    result.offset !== offset ||
    Buffer.byteLength(result.data, "base64") !== Math.max(0, Math.min(length, result.size - offset))
  ) {
    throw changed();
  }
  return result;
}

function costOf(result: Content): number {
  const payload =
    result.kind === "image" || result.kind === "bytes"
      ? result.data
      : result.kind === "text"
        ? result.text
        : "";
  return 2 * (payload.length + result.path.length + (result.version?.length ?? 0));
}

export class PeerFileReads {
  private readonly entries = new Map<string, Entry>();
  private readonly flights = new Map<string, Flight>();
  private readonly peers = new Map<
    string,
    {
      controller: AbortController;
      rejoins: number;
      versioned: boolean;
      files: boolean | undefined;
      grants: boolean;
    }
  >();
  private total = 0;
  private wholeReads = 0;
  private spanReads = 0;

  constructor(
    private readonly request: (
      deviceId: string,
      params: Params,
      signal: AbortSignal,
    ) => Promise<Result>,
    private readonly limits = {
      bytes: CACHE_BYTES,
      entries: CACHE_ENTRIES,
      fileBytes: MAX_FILE_BYTES,
    },
    private readonly grants?: PeerFileGrants,
  ) {}

  updateRoom(state: RoomState): void {
    const online = new Map(
      state.status === "online" ? state.peers.filter((p) => p.online).map((p) => [p.id, p]) : [],
    );
    for (const [id, scope] of this.peers) {
      const peer = online.get(id);
      if (
        !peer ||
        scope.rejoins !== (peer.rejoins ?? 0) ||
        scope.versioned !== supportsFileVersions(peer.schema) ||
        scope.files !== peer.serves?.includes("files") ||
        scope.grants !== (peer.serves?.includes(FILE_GRANTS) === true)
      ) {
        this.invalidateDevice(id);
      }
    }
    for (const [id, peer] of online) {
      if (this.peers.has(id)) continue;
      this.peers.set(id, {
        controller: new AbortController(),
        rejoins: peer.rejoins ?? 0,
        versioned: supportsFileVersions(peer.schema),
        files: peer.serves?.includes("files"),
        grants: peer.serves?.includes(FILE_GRANTS) === true,
      });
    }
    this.grants?.updateRoom(state);
  }

  invalidateDevice(id: string): void {
    this.grants?.invalidateDevice(id);
    const scope = this.peers.get(id);
    if (!scope) return;
    this.peers.delete(id);
    const prefix = `${JSON.stringify([id]).slice(0, -1)},`;
    for (const [key, flight] of this.flights)
      if (flight.file.startsWith(prefix)) this.flights.delete(key);
    for (const [key, entry] of this.entries) if (entry.file.startsWith(prefix)) this.remove(key);
    scope.controller.abort();
  }

  private scope(peer: PeerWorkspace, path: string) {
    const scope = this.peers.get(peer.deviceId);
    if (!scope) throw unavailable("that device is not in the room");
    return {
      file: JSON.stringify([peer.deviceId, peer.workspaceId, path]),
      peer,
      path,
      ...scope,
      signal: scope.controller.signal,
    };
  }

  async read(
    peer: PeerWorkspace,
    path: string,
    shape: Shape,
    signal?: AbortSignal,
    probe = false,
  ): Promise<Content> {
    return this.piece(this.scope(peer, path), shape, signal, undefined, probe);
  }

  async openBytes(
    peer: PeerWorkspace,
    path: string,
    offset: number,
    length: number,
    signal?: AbortSignal,
    required?: string,
  ): Promise<OpenBytes> {
    const scope = this.scope(peer, path);
    if (length === 0 && !scope.versioned) length = MAX_BYTES_CHUNK;
    const first = bytesOf(
      await this.piece(scope, { as: "bytes", offset, length }, signal, required),
      offset,
      length,
    );
    return {
      first,
      signal: scope.signal,
      read: async (at: number, count: number) => {
        const piece = bytesOf(
          await this.piece(
            scope,
            { as: "bytes", offset: at, length: count },
            signal,
            first.version,
            true,
          ),
          at,
          count,
        );
        if (piece.size !== first.size || piece.version !== first.version) throw changed();
        return piece;
      },
    };
  }

  async readBytes(
    peer: PeerWorkspace,
    path: string,
    offset: number,
    length: number,
    whole: boolean,
    required?: string,
    signal?: AbortSignal,
  ): Promise<{ parts: string[]; size: number; version?: string }> {
    const scope = this.scope(peer, path);
    const multiPiece = length > MAX_BYTES_CHUNK;
    if (multiPiece && this.spanReads >= MAX_SPAN_READS) {
      throw unavailable("too many file reads in progress");
    }
    const assembleWhole = whole && scope.versioned && this.wholeReads < MAX_WHOLE_READS;
    if (assembleWhole) this.wholeReads++;
    if (multiPiece) this.spanReads++;
    try {
      if (!scope.versioned && multiPiece) {
        const reads = await Promise.all(
          this.slices(offset, offset + length).map(async ([at, count]) =>
            bytesOf(
              await this.piece(scope, { as: "bytes", offset: at, length: count }, signal, required),
              at,
              count,
            ),
          ),
        );
        const size = reads[0]?.size ?? 0;
        if (reads.some((read) => read.size !== size)) throw changed();
        return { parts: reads.map((read) => read.data), size };
      }

      const { first, read } = await this.openBytes(
        peer,
        path,
        offset,
        Math.min(length, MAX_BYTES_CHUNK),
        signal,
        required,
      );
      const { size, version } = first;
      const end =
        assembleWhole && size <= this.limits.fileBytes ? size : Math.min(offset + length, size);
      const offsets = this.slices(offset + Buffer.byteLength(first.data, "base64"), end);
      const parts = [first.data];
      for (let i = 0; i < offsets.length; i += 4) {
        const batch = await Promise.all(
          offsets.slice(i, i + 4).map(([at, count]) => read(at, count)),
        );
        parts.push(...batch.map((piece) => piece.data));
      }
      throwIfAborted(scope.signal);
      throwIfAborted(signal);
      return { parts, size, ...(version ? { version } : {}) };
    } finally {
      if (assembleWhole) this.wholeReads--;
      if (multiPiece) this.spanReads--;
    }
  }

  private slices(start: number, end: number): [number, number][] {
    const result: [number, number][] = [];
    for (let at = start; at < end; at += MAX_BYTES_CHUNK) {
      result.push([at, Math.min(MAX_BYTES_CHUNK, end - at)]);
    }
    return result;
  }

  private async piece(
    scope: ReturnType<PeerFileReads["scope"]>,
    shape: Shape,
    signal?: AbortSignal,
    required?: string,
    authorized = false,
  ): Promise<Content> {
    const grants = scope.grants ? this.grants : undefined;
    if (!grants) return this.pieceWith(scope, shape, signal, required, authorized);
    if (grants.stale(scope.peer, scope.path)) {
      await grants.renew(scope.peer, scope.path, signal).catch(() => false);
    }
    try {
      return await this.pieceWith(
        scope,
        shape,
        signal,
        required,
        authorized,
        grants.token(scope.peer, scope.path),
      );
    } catch (error) {
      const failure = grantFailure(error);
      if (failure === "invalid") grants.forget(scope.peer, scope.path);
      if (failure !== "expired" && failure !== "required") throw error;
      if (!(await grants.renew(scope.peer, scope.path, signal))) throw error;
      return this.pieceWith(
        scope,
        shape,
        signal,
        required,
        authorized,
        grants.token(scope.peer, scope.path),
      );
    }
  }

  private async pieceWith(
    scope: ReturnType<PeerFileReads["scope"]>,
    shape: Shape,
    signal: AbortSignal | undefined,
    required: string | undefined,
    authorized: boolean,
    grant?: string,
  ): Promise<Content> {
    throwIfAborted(signal);
    throwIfAborted(scope.signal);
    const { as, offset, length, maxBytes } = shape;
    const key = JSON.stringify([scope.file, as, offset, length, maxBytes, grant !== undefined]);
    const versioned = scope.versioned && (!authorized || required !== undefined);
    const cached = versioned ? this.lookup(scope.file, key, shape, required) : undefined;
    if (required && !scope.versioned) throw changed();
    if (cached && authorized && required) return cached;

    const condition = cached?.version;
    const requestKey = JSON.stringify([key, versioned, condition, required]);
    let flight = this.flights.get(requestKey);
    if (!flight) {
      if (this.flights.size >= MAX_PENDING) throw unavailable("too many file reads in progress");
      const controller = new AbortController();
      const requestSignal = AbortSignal.any([scope.signal, controller.signal]);
      const params: Params = {
        workspaceId: scope.peer.workspaceId,
        path: scope.path,
        ...shape,
        ...(grant !== undefined ? { grant } : {}),
        ...(versioned
          ? condition
            ? { ifVersion: condition }
            : required
              ? { requireVersion: required }
              : { versioned: true }
          : {}),
      };
      const promise = this.request(scope.peer.deviceId, params, requestSignal)
        .then((result) => {
          throwIfAborted(requestSignal);
          if (result.kind === "notModified") {
            if (!cached || condition !== result.version) throw changed();
            return cached;
          }
          if (required && result.version !== required) throw changed();
          if (as === "bytes") bytesOf(result, offset ?? 0, length ?? MAX_BYTES_CHUNK);
          if (versioned) {
            if (result.version) this.store(scope.file, key, shape, result);
            else this.dropFile(scope.file);
          }
          return result;
        })
        .catch((error: unknown) => {
          if (!requestSignal.aborted && !isAbortError(error)) this.dropFile(scope.file, requestKey);
          throw error;
        })
        .finally(() => {
          if (this.flights.get(requestKey)?.controller === controller)
            this.flights.delete(requestKey);
        });
      flight = { file: scope.file, controller, promise, waiters: 0 };
      this.flights.set(requestKey, flight);
    }

    const shared = flight;
    shared.waiters++;
    const waiter = signal ? AbortSignal.any([signal, scope.signal]) : scope.signal;
    try {
      return await new Promise<Content>((resolve, reject) => {
        const abort = () => reject(createAbortError());
        if (waiter.aborted) abort();
        else waiter.addEventListener("abort", abort, { once: true });
        shared.promise
          .then(resolve, reject)
          .finally(() => waiter.removeEventListener("abort", abort));
      });
    } finally {
      shared.waiters--;
      if (!shared.waiters && this.flights.get(requestKey) === shared) {
        this.flights.delete(requestKey);
        shared.controller.abort();
      }
    }
  }

  private lookup(file: string, key: string, shape: Shape, required?: string): Content | undefined {
    const exact = this.entries.get(key);
    if (exact && (!required || exact.result.version === required)) {
      this.touch(key, exact);
      return exact.result;
    }
    if (shape.as !== "bytes") return;
    const at = shape.offset ?? 0;
    for (const [entryKey, entry] of this.entries) {
      const bytes = entry.result;
      if (entry.file !== file || bytes.kind !== "bytes" || (required && bytes.version !== required))
        continue;
      const length = Math.max(0, Math.min(shape.length ?? MAX_BYTES_CHUNK, bytes.size - at));
      const start = at - bytes.offset;
      if (start < 0 || start + length > Buffer.byteLength(bytes.data, "base64")) continue;
      this.touch(entryKey, entry);
      return {
        ...bytes,
        offset: at,
        data: Buffer.from(bytes.data, "base64")
          .subarray(start, start + length)
          .toString("base64"),
      };
    }
  }

  private store(file: string, key: string, shape: Shape, result: Content): void {
    for (const [other, entry] of this.entries) {
      if (entry.file === file && entry.result.version !== result.version) this.remove(other);
    }
    if (shape.length === 0) return;
    const cost = costOf(result) + 2 * (file.length + key.length);
    const openingChunk =
      result.kind === "bytes" && (shape.offset === 0 || shape.offset === MAX_BYTES_CHUNK);
    if ((result.size > this.limits.fileBytes && !openingChunk) || cost > this.limits.bytes) return;
    if (result.size > this.limits.fileBytes && result.kind === "bytes") {
      for (const [other, entry] of this.entries) {
        if (
          entry.file === file &&
          entry.result.kind === "bytes" &&
          entry.result.offset === result.offset
        ) {
          this.remove(other);
        }
      }
    }
    this.remove(key);
    this.entries.set(key, { file, result, cost });
    this.total += cost;
    for (const oldest of this.entries.keys()) {
      if (this.total <= this.limits.bytes && this.entries.size <= this.limits.entries) break;
      this.remove(oldest);
    }
  }

  private touch(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.total -= entry.cost;
    this.entries.delete(key);
  }

  private dropFile(file: string, failed?: string): void {
    for (const [key, entry] of this.entries) if (entry.file === file) this.remove(key);
    if (!failed) return;
    for (const [key, flight] of this.flights) {
      if (key === failed || file !== flight.file) continue;
      this.flights.delete(key);
      flight.controller.abort();
    }
  }
}
