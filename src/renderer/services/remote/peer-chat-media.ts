// Read results shared by the remote chats in this renderer. A peer connection
// scopes both settled entries and requests that have yet to answer.

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

interface Access {
  id: number;
  cacheId: number;
  scopeId: number;
  signal: AbortSignal;
}

interface CacheLimits<T> {
  entries: number;
  bytes: number;
  freshMs: number;
  size(value: T): number;
  revalidate?: boolean;
}

const MAX_ACTIVE = 64;
const MAX_WAITING = 256;

function peerReads<T>(limits?: CacheLimits<T>, maxActive = MAX_ACTIVE) {
  const cached = new Map<string, { cacheId: number; value: T; bytes: number; until: number }>();
  const pending = new Map<string, Promise<T>>();
  const waiting = new Map<
    string,
    { access: Access; start(): void; reject(reason: unknown): void }
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

  const scoped = (access: Access, key: string) => `${access.id}:${key}`;
  return {
    subscribe(access: Access | null, key: string, listener: (value: T | null) => void) {
      return access && !access.signal.aborted
        ? results.subscribe(scoped(access, key), listener)
        : () => {};
    },
    revoke(access: Access, keepCandidates = false) {
      for (const [key, job] of waiting) {
        if (job.access === access) {
          waiting.delete(key);
          job.reject(access.signal.reason);
        }
      }
      if (!keepCandidates) {
        for (const [key, item] of cached) {
          if (item.cacheId === access.cacheId) drop(key);
        }
      }
    },
    async read(
      access: Access | null,
      key: string,
      load: (signal: AbortSignal, known: T | undefined) => Promise<T>,
    ) {
      if (!access || access.signal.aborted) throw new Error("peer connection unavailable");
      const slot = scoped(access, key);
      const cacheKey = `${access.cacheId}:${key}`;
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
                cacheId: access.cacheId,
                value: next,
                bytes: weight,
                until: Date.now() + limits.freshMs,
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
          // Start after recording the promise, including when IPC throws immediately.
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

// Budget the retained strings at up to two bytes per code unit plus entry
// limits for object/collection overhead. Mutable pictures only share IPC in flight.
const IMAGE_EDGE = 2048;
interface Attachment {
  image: ImageBlock;
  version?: string;
}

const attachments = peerReads<Attachment>({
  revalidate: true,
  entries: 128,
  bytes: 16 * 1024 * 1024,
  freshMs: 30_000,
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

// The host limits concurrent whole-file image reads and queues only a few.
const pictures = peerReads<ImageBlock>(undefined, 8);

function mediaAccess(
  access: Access | null,
  target: readonly string[],
  visible: boolean,
): ChatMediaAccess | null {
  return (
    access && {
      scope: JSON.stringify([access.scopeId, ...target]),
      signal: access.signal,
      visible,
    }
  );
}

export function peerImageLoader(
  target: { deviceId: string; workspaceId: string; tabId: string },
  access: Access | null,
  visible = true,
): ImageLoader {
  const site = [target.deviceId, target.workspaceId, target.tabId];
  const current = visible ? access : null;
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
      access: mediaAccess(access, site, visible),
      subscribe: (ref: RemoteImageRef, listener: (image: ImageBlock | null) => void) =>
        attachments.subscribe(current, key(ref), (next) => listener(next?.image ?? null)),
    },
  );
}

/** A path's folder and name, by either separator (that computer may be Windows). */
function splitPath(path: string): { dir: string; name: string } | null {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (cut < 0 || cut === path.length - 1) return null;
  const root = cut === 0 || /^[A-Za-z]:$/.test(path.slice(0, cut));
  return { dir: path.slice(0, root ? cut + 1 : cut), name: path.slice(cut + 1) };
}

export function peerChatFiles(
  { deviceId, workspaceId }: { deviceId: string; workspaceId: string },
  access: Access | null,
  visible = true,
): ChatFiles {
  const where = { deviceId, workspaceId };
  const current = visible ? access : null;
  const key = (path: string) => JSON.stringify([deviceId, workspaceId, path]);
  const namesIn = (path: string) =>
    folderNames.read(current, key(path), async (signal) => {
      const result = await ipcCallResult("remote", "peerFilesList", { ...where, path }, { signal });
      if (!result.ok) throw new Error(result.message);
      return new Set(result.value.entries.filter((e) => e.kind !== "dir").map((e) => e.name));
    });
  return {
    access: mediaAccess(access, [deviceId, workspaceId], visible),
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
      // Large lookups still get a chance to visit each folder, without
      // starting an IPC for every directory at once.
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
    picture(path) {
      return pictures.read(current, key(path), async (signal) => {
        // Main checks the current file and its access on every distinct read.
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
  access: Access | null;
}

const watched = new Map<string, WatchedPeer>();
let room: RoomState | null = null;
let nextAccess = 0;
let stopWatching: (() => void) | undefined;

function reset(peer: WatchedPeer, connection: string | null, reads: string | null = null) {
  const previous = peer.access;
  const foreground = previous !== null && connection === peer.connection;
  if (previous) {
    peer.controller?.abort();
    attachments.revoke(previous, foreground);
    folderNames.revoke(previous);
    pictures.revoke(previous);
  }
  const controller = connection === null ? undefined : new AbortController();
  const id = ++nextAccess;
  // Mounted views can keep their last result through a rejoin while read access lasts.
  const scopeId = previous && peer.reads === reads ? previous.scopeId : id;
  peer.controller = controller;
  peer.connection = connection;
  peer.reads = reads;
  peer.access = controller
    ? { id, cacheId: foreground ? previous.cacheId : id, scopeId, signal: controller.signal }
    : null;
  peer.listeners.notify(undefined);
}

function updatePeer(id: string, watcher: WatchedPeer, refresh = false) {
  const peer = room?.status === "online" ? room.peers.find((p) => p.id === id) : undefined;
  const serves = peer?.serves?.slice().sort();
  const connection = peer?.online ? JSON.stringify([peer.rejoins ?? 0, peer.schema, serves]) : null;
  if (connection !== watcher.connection || (refresh && connection !== null)) {
    const reads = serves?.filter((method) => method === "chat.read" || method === "files");
    reset(watcher, connection, JSON.stringify(reads ?? ["chat.read", "files"]));
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

export function peerChatAccess(deviceId: string): Access | null {
  return watched.get(deviceId)?.access ?? null;
}

export function usePeerChatAccess(deviceId: string): Access | null {
  const subscribe = useCallback(
    (notify: () => void) => watchPeerChatAccess(deviceId, notify),
    [deviceId],
  );
  const snapshot = useCallback(() => peerChatAccess(deviceId), [deviceId]);
  return useSyncExternalStore(subscribe, snapshot);
}
