import { useCallback, useSyncExternalStore } from "react";
import type { RemoteAccountState } from "../../../shared/remote/account";
import type { RoomState } from "../../../shared/remote/room";
import { createKeyedListenerBus, createListenerBus } from "../../../shared/util/listener-bus";
import { ipcCallResult, ipcListen } from "../../ipc/client";
import type { ChatFiles } from "../chat/chat-files";
import {
  type ChatMediaAccess,
  type ImageBlock,
  type ImageLoader,
  type RemoteImageRef,
  remoteImageKey,
} from "../chat/model";
import { peerRejoins } from "./room";

interface ReadAccess {
  id: number;
  cacheId: number;
  scopeId: number;
  signal: AbortSignal;
}

interface PeerAccess {
  scopeId: number;
  read: ReadAccess | null;
}

interface CacheLimits<T> {
  entries: number;
  bytes: number;
  freshMs?: number;
  scope?: (access: ReadAccess) => number;
  size(value: T): number;
  revalidate?: boolean;
}

const MAX_ACTIVE = 64;
const MAX_WAITING = 256;

function peerReads<T>(limits?: CacheLimits<T>, maxActive = MAX_ACTIVE) {
  const cached = new Map<string, { scope: number; value: T; bytes: number; until: number }>();
  const pending = new Map<string, Promise<T>>();
  const waiting = new Map<
    string,
    { access: ReadAccess; start(): void; reject(reason: unknown): void }
  >();
  let active = 0;
  const results = createKeyedListenerBus<string, T | null>();
  let bytes = 0;

  function drop(key: string) {
    const item = cached.get(key);
    if (!item) return;
    bytes -= item.bytes;
    cached.delete(key);
  }

  function hit(key: string, now: number): T | undefined {
    const item = cached.get(key);
    if (!item) return undefined;
    drop(key);
    if (item.until <= now) return undefined;
    cached.set(key, item);
    bytes += item.bytes;
    return item.value;
  }

  const scoped = (access: ReadAccess, key: string) => `${access.id}:${key}`;
  return {
    subscribe(access: ReadAccess | null, key: string, listener: (value: T | null) => void) {
      return access && !access.signal.aborted
        ? results.subscribe(scoped(access, key), listener)
        : () => {};
    },
    revoke(access: ReadAccess) {
      for (const [key, job] of waiting) {
        if (job.access === access) {
          waiting.delete(key);
          job.reject(access.signal.reason);
        }
      }
    },
    clear(scope: number) {
      for (const [key, item] of cached) {
        if (item.scope === scope) drop(key);
      }
    },
    async read(
      access: ReadAccess | null,
      key: string,
      load: (signal: AbortSignal, known: T | undefined) => Promise<T>,
    ) {
      if (!access || access.signal.aborted) throw new Error("peer connection unavailable");
      const slot = scoped(access, key);
      const scope = limits?.scope?.(access) ?? access.cacheId;
      const cacheKey = `${scope}:${key}`;
      if (!limits?.revalidate) {
        const value = hit(cacheKey, Date.now());
        if (value !== undefined) return value;
      }
      const existing = pending.get(slot);
      if (existing) return existing;
      if (waiting.size >= MAX_WAITING) throw new Error("too many peer chat reads");

      const run = async () => {
        try {
          access.signal.throwIfAborted();
          const next = await load(access.signal, hit(cacheKey, Date.now()));
          access.signal.throwIfAborted();
          if (limits) {
            drop(cacheKey);
            const weight = 2 * cacheKey.length + limits.size(next);
            if (weight <= limits.bytes) {
              cached.set(cacheKey, {
                scope,
                value: next,
                bytes: weight,
                until: Date.now() + (limits.freshMs ?? Infinity),
              });
              bytes += weight;
              for (const [old] of cached) {
                if (bytes <= limits.bytes && cached.size <= limits.entries) break;
                drop(old);
              }
            }
          }
          results.notify(slot, next);
          return next;
        } catch (error) {
          if (!access.signal.aborted) {
            drop(cacheKey);
            results.notify(slot, null);
          }
          throw error;
        } finally {
          active--;
          const queued = waiting.entries().next().value;
          if (queued) {
            const [queuedKey, job] = queued;
            waiting.delete(queuedKey);
            job.start();
          }
        }
      };
      const request = new Promise<T>((resolve, reject) => {
        const start = () => {
          active++;
          Promise.resolve().then(run).then(resolve, reject);
        };
        if (active < maxActive) start();
        else waiting.set(slot, { access, start, reject });
      }).finally(() => pending.delete(slot));
      pending.set(slot, request);
      return request;
    },
  };
}

const IMAGE_EDGE = 2048;
interface Attachment {
  image: ImageBlock;
  version?: string;
}

const attachments = peerReads<Attachment>({
  revalidate: true,
  scope: (access) => access.scopeId,
  entries: 128,
  bytes: 16 * 1024 * 1024,
  size: ({ image, version }) =>
    version === undefined
      ? Infinity
      : 2 * (image.data.length + image.mediaType.length + version.length),
});

const folderNames = peerReads<ReadonlySet<string>>({
  entries: 64,
  bytes: 512 * 1024,
  freshMs: 5_000,
  size: (names) => {
    let bytes = 0;
    for (const name of names) bytes += 2 * name.length + 32;
    return bytes;
  },
});

const pictures = peerReads<ImageBlock>(undefined, 8);

const presence = peerReads<boolean>({
  entries: 512,
  bytes: 256 * 1024,
  freshMs: 30_000,
  size: () => 64,
});

function mediaAccess(
  access: PeerAccess | null,
  target: readonly string[],
  read: ReadAccess | null,
): ChatMediaAccess | null {
  return (
    access && {
      scope: JSON.stringify([access.scopeId, ...target]),
      signal: read?.signal ?? null,
    }
  );
}

export function peerImageLoader(
  target: { deviceId: string; workspaceId: string; tabId: string },
  access: PeerAccess | null,
  visible = true,
): ImageLoader {
  const site = [target.deviceId, target.workspaceId, target.tabId];
  const current = visible ? (access?.read ?? null) : null;
  const key = (ref: RemoteImageRef) => JSON.stringify([...site, IMAGE_EDGE, remoteImageKey(ref)]);
  return Object.assign(
    (image: ImageBlock) => {
      const ref = image.remote;
      if (!ref || image.data) return Promise.resolve(image);
      return attachments
        .read(current, key(ref), async (signal, known) => {
          const result = await ipcCallResult(
            "remote",
            "peerChatImage",
            {
              ...target,
              maxEdge: IMAGE_EDGE,
              ref,
              ...(known?.version
                ? { ifVersion: known.version }
                : ref.kind !== "held"
                  ? { versioned: true as const }
                  : {}),
            },
            { signal },
          );
          if (!result.ok) throw new Error(result.message);
          const { mediaType, data, version, notModified } = result.value;
          if (notModified) {
            if (!known || version !== known.version || data !== "") {
              throw new Error("unexpected attachment validation result");
            }
            return known;
          }
          if (!data) throw new Error("empty attachment");
          return { image: { mediaType, data }, version: ref.kind === "held" ? undefined : version };
        })
        .then(({ image }) => image);
    },
    {
      access: mediaAccess(access, site, current),
      subscribe: (ref: RemoteImageRef, listener: (image: ImageBlock | null) => void) =>
        attachments.subscribe(current, key(ref), (next) => listener(next?.image ?? null)),
    },
  );
}

function splitPath(path: string): { dir: string; name: string } | null {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (cut < 0 || cut === path.length - 1) return null;
  const root = cut === 0 || /^[A-Za-z]:$/.test(path.slice(0, cut));
  return { dir: path.slice(0, root ? cut + 1 : cut), name: path.slice(cut + 1) };
}

export function peerChatFiles(
  { deviceId, workspaceId }: { deviceId: string; workspaceId: string },
  access: PeerAccess | null,
  visible = true,
): ChatFiles {
  const where = { deviceId, workspaceId };
  const current = visible ? (access?.read ?? null) : null;
  const key = (path: string) => JSON.stringify([deviceId, workspaceId, path]);
  const namesIn = (path: string) =>
    folderNames.read(current, key(path), async (signal) => {
      const result = await ipcCallResult("remote", "peerFilesList", { ...where, path }, { signal });
      if (!result.ok) throw new Error(result.message);
      return new Set(result.value.entries.filter((e) => e.kind !== "dir").map((e) => e.name));
    });
  return {
    access: mediaAccess(access, [deviceId, workspaceId], current),
    epoch: current?.id ?? null,
    connection: current?.cacheId ?? null,
    async there(paths) {
      if (!current || current.signal.aborted) return new Set<string>();
      const byDir = new Map<string, { path: string; name: string }[]>();
      for (const path of paths) {
        const parts = splitPath(path);
        if (!parts) continue;
        const inDir = byDir.get(parts.dir) ?? [];
        inDir.push({ path, name: parts.name });
        byDir.set(parts.dir, inDir);
      }
      const dirs = [...byDir];
      const found = new Set<string>();
      for (let i = 0; i < dirs.length && !current.signal.aborted; i += MAX_ACTIVE) {
        await Promise.all(
          dirs.slice(i, i + MAX_ACTIVE).map(async ([dir, entries]) => {
            const names = await namesIn(dir).catch(() => null);
            for (const { path, name } of entries) {
              if (names?.has(name)) found.add(path);
            }
          }),
        );
      }
      return current.signal.aborted ? new Set() : new Set(paths.filter((path) => found.has(path)));
    },
    async gone(paths) {
      if (!current || current.signal.aborted) return new Set<string>();
      const missing = new Set<string>();
      await Promise.all(
        paths.map(async (path) => {
          const there = await presence
            .read(current, key(path), async (signal) => {
              const result = await ipcCallResult(
                "remote",
                "peerFilesRead",
                { ...where, path, as: "bytes", length: 0, versioned: true },
                { signal },
              );
              if (result.ok) return true;
              if (result.kind === "not-found") return false;
              throw new Error(result.message);
            })
            .catch(() => true);
          if (!there) missing.add(path);
        }),
      );
      return current.signal.aborted ? new Set() : missing;
    },
    picture(path) {
      return pictures.read(current, key(path), async (signal) => {
        const result = await ipcCallResult(
          "remote",
          "peerFilesRead",
          { ...where, path },
          { signal },
        );
        if (!result.ok || result.value.kind !== "image") {
          throw new Error(result.ok ? "not an image" : result.message);
        }
        return { mediaType: result.value.mediaType, data: result.value.data };
      });
    },
    subscribePicture(path, listener) {
      return pictures.subscribe(current, key(path), listener);
    },
  };
}

interface WatchedPeer {
  listeners: ReturnType<typeof createListenerBus<void>>;
  connection: string | null;
  reads: string | null;
  controller?: AbortController;
  access: PeerAccess | null;
}

const watched = new Map<string, WatchedPeer>();
let room: RoomState | null = null;
let nextAccess = 0;
let stopWatching: (() => void) | undefined;

function reset(peer: WatchedPeer, connection: string | null, reads: string | null = null) {
  const previous = peer.access;
  const previousRead = previous?.read;
  const foreground = previousRead && connection === peer.connection;
  if (previousRead) {
    peer.controller?.abort();
    attachments.revoke(previousRead);
    folderNames.revoke(previousRead);
    folderNames.clear(previousRead.cacheId);
    presence.revoke(previousRead);
    presence.clear(previousRead.cacheId);
    pictures.revoke(previousRead);
  }
  const controller = connection === null ? undefined : new AbortController();
  const id = ++nextAccess;
  const keep = previous && reads !== null && peer.reads === reads;
  const scopeId = keep ? previous.scopeId : id;
  if (previous && !keep) attachments.clear(previous.scopeId);
  peer.controller = controller;
  peer.connection = connection;
  peer.reads = reads;
  const read = controller
    ? { id, cacheId: foreground ? previousRead.cacheId : id, scopeId, signal: controller.signal }
    : null;
  peer.access = reads === null ? null : { scopeId, read };
  peer.listeners.notify(undefined);
}

function updatePeer(id: string, watcher: WatchedPeer, refresh = false) {
  const peer = room?.status === "online" ? room.peers.find((p) => p.id === id) : undefined;
  const serves = peer?.serves?.slice().sort();
  const connection = peer?.online ? JSON.stringify([peerRejoins(peer), peer.schema, serves]) : null;
  const allowed = serves?.filter((method) => method === "chat.read" || method === "files");
  const reads = peer ? JSON.stringify(allowed ?? ["chat.read", "files"]) : null;
  if (
    reads !== watcher.reads ||
    connection !== watcher.connection ||
    (refresh && connection !== null)
  ) {
    reset(watcher, connection, reads);
  }
}

function applyRoom(next: RoomState | null, refresh = false) {
  room = next;
  for (const [id, watcher] of [...watched]) {
    if (watched.get(id) === watcher) updatePeer(id, watcher, refresh);
  }
}

function listenForAccess() {
  let live = true;
  let roomTold = false;
  let account: string | null | undefined;
  const accountId = (state: RemoteAccountState) =>
    state.status === "signed-in"
      ? JSON.stringify([state.server, state.user.id, state.device.id])
      : null;
  const offRoom = ipcListen("remote", "roomChanged", (next) => {
    roomTold = true;
    applyRoom(next);
  });
  const offAccount = ipcListen("remote", "accountChanged", (next) => {
    const id = accountId(next);
    if (id === null || (account !== undefined && account !== id)) {
      roomTold = true;
      applyRoom(null);
    }
    account = id;
  });
  const foreground = () => {
    if (document.visibilityState === "visible") applyRoom(room, true);
  };
  window.addEventListener("focus", foreground);
  document.addEventListener("visibilitychange", foreground);
  void ipcCallResult("remote", "account", undefined)
    .then((result) => {
      if (live && account === undefined && result.ok) account = accountId(result.value);
    })
    .catch(() => {});
  void ipcCallResult("remote", "room", undefined)
    .then((result) => {
      if (live && !roomTold && result.ok) applyRoom(result.value);
    })
    .catch(() => {});
  return () => {
    live = false;
    offRoom();
    offAccount();
    window.removeEventListener("focus", foreground);
    document.removeEventListener("visibilitychange", foreground);
    room = null;
  };
}

export function watchPeerChatAccess(deviceId: string, notify: () => void): () => void {
  const peer = watched.get(deviceId) ?? {
    listeners: createListenerBus(),
    connection: null,
    reads: null,
    access: null,
  };
  watched.set(deviceId, peer);
  const off = peer.listeners.subscribe(notify);
  stopWatching ??= listenForAccess();
  updatePeer(deviceId, peer);
  return () => {
    off();
    if (watched.get(deviceId) !== peer) return;
    if (peer.listeners.size === 0) {
      reset(peer, null);
      watched.delete(deviceId);
    }
    if (watched.size === 0) {
      stopWatching?.();
      stopWatching = undefined;
    }
  };
}

export function peerChatAccess(deviceId: string): PeerAccess | null {
  return watched.get(deviceId)?.access ?? null;
}

export function usePeerChatAccess(deviceId: string): PeerAccess | null {
  const subscribe = useCallback(
    (notify: () => void) => watchPeerChatAccess(deviceId, notify),
    [deviceId],
  );
  const snapshot = useCallback(() => peerChatAccess(deviceId), [deviceId]);
  return useSyncExternalStore(subscribe, snapshot);
}
