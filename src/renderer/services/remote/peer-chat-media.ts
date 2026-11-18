// Read results shared by the remote chats in this renderer. A peer connection
// scopes both settled entries and requests that have yet to answer.

import { useCallback, useSyncExternalStore } from "react";
import type { RoomState } from "../../../shared/remote/room";
import { createKeyedListenerBus, createListenerBus } from "../../../shared/util/listener-bus";
import { ipcCallResult, ipcListen } from "../../ipc/client";
import type { ChatFiles } from "../chat/chat-files";
import type { ImageBlock, ImageLoader, RemoteImageRef } from "../chat/model";

interface Access {
  id: number;
  signal: AbortSignal;
}

interface CacheLimits<T> {
  entries: number;
  bytes: number;
  freshMs: number;
  size(value: T): number;
  revalidate?: boolean;
}

const MAX_PENDING = 64;

function peerReads<T>(limits?: CacheLimits<T>) {
  const cached = new Map<string, { access: Access; value: T; bytes: number; until: number }>();
  const pending = new Map<string, Promise<T>>();
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
    evict(access: Access) {
      for (const [key, item] of cached) {
        if (item.access === access) drop(key);
      }
    },
    async read(
      access: Access | null,
      key: string,
      load: (signal: AbortSignal, known: T | undefined) => Promise<T>,
    ) {
      if (!access || access.signal.aborted) throw new Error("peer connection unavailable");
      const slot = scoped(access, key);
      const value = hit(slot, Date.now());
      if (value !== undefined && !limits?.revalidate) return value;
      const existing = pending.get(slot);
      if (existing) return existing;
      if (pending.size >= MAX_PENDING) throw new Error("too many peer chat reads");

      // Install the promise before invoking IPC; synchronous throws and
      // asynchronous rejections both release the slot.
      const request = Promise.resolve()
        .then(() => {
          access.signal.throwIfAborted();
          return load(access.signal, value);
        })
        .then((next) => {
          access.signal.throwIfAborted();
          if (limits) {
            drop(slot);
            const weight = 2 * slot.length + limits.size(next);
            if (weight <= limits.bytes) {
              cached.set(slot, {
                access,
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
        })
        .catch((error) => {
          drop(slot);
          if (!access.signal.aborted) results.notify(slot, null);
          throw error;
        })
        .finally(() => pending.delete(slot));
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

const pictures = peerReads<ImageBlock>();

function imageKey(ref: RemoteImageRef): string {
  const id = ref.kind === "user" ? ref.itemKey : ref.kind === "tool" ? ref.toolUseId : ref.id;
  return JSON.stringify([ref.kind, id, ref.index]);
}

export function peerImageLoader(
  target: { deviceId: string; workspaceId: string; tabId: string },
  access: Access | null,
): ImageLoader {
  const key = (ref: RemoteImageRef) =>
    JSON.stringify([target.deviceId, target.workspaceId, target.tabId, IMAGE_EDGE, imageKey(ref)]);
  return Object.assign(
    (image: ImageBlock) => {
      const ref = image.remote;
      if (!ref || image.data) return Promise.resolve(image);
      return attachments
        .read(access, key(ref), async (signal, known) => {
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
      subscribe: (ref: RemoteImageRef, listener: (image: ImageBlock | null) => void) =>
        attachments.subscribe(access, key(ref), (next) => listener(next?.image ?? null)),
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
  where: { deviceId: string; workspaceId: string },
  access: Access | null,
): ChatFiles {
  const key = (path: string) => JSON.stringify([where.deviceId, where.workspaceId, path]);
  const namesIn = (path: string) =>
    folderNames.read(access, key(path), async (signal) => {
      const result = await ipcCallResult("remote", "peerFilesList", { ...where, path }, { signal });
      if (!result.ok) throw new Error(result.message);
      return new Set(result.value.entries.filter((e) => e.kind !== "dir").map((e) => e.name));
    });
  return {
    epoch: access?.id ?? null,
    async there(paths) {
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
      for (let i = 0; i < dirs.length; i += MAX_PENDING) {
        await Promise.all(
          dirs.slice(i, i + MAX_PENDING).map(async ([dir, entries]) => {
            const names = await namesIn(dir).catch(() => null);
            for (const { path, name } of entries) {
              if (names?.has(name)) found.add(path);
            }
          }),
        );
      }
      return access?.signal.aborted ? new Set() : new Set(paths.filter((path) => found.has(path)));
    },
    picture(path) {
      return pictures.read(access, key(path), async (signal) => {
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
      return pictures.subscribe(access, key(path), listener);
    },
  };
}

interface WatchedPeer {
  listeners: ReturnType<typeof createListenerBus<void>>;
  connection: string | null;
  controller?: AbortController;
  access: Access | null;
}

const watched = new Map<string, WatchedPeer>();
let room: RoomState | null = null;
let nextAccess = 0;
let stopWatching: (() => void) | undefined;

function reset(peer: WatchedPeer, connection: string | null) {
  if (peer.access) {
    peer.controller?.abort();
    attachments.evict(peer.access);
    folderNames.evict(peer.access);
  }
  const controller = connection === null ? undefined : new AbortController();
  peer.controller = controller;
  peer.connection = connection;
  peer.access = controller ? { id: ++nextAccess, signal: controller.signal } : null;
  peer.listeners.notify(undefined);
}

function applyRoom(next: RoomState | null, refresh = false) {
  room = next;
  for (const [id, watcher] of watched) {
    const peer = room?.status === "online" ? room.peers.find((p) => p.id === id) : undefined;
    const connection = peer?.online
      ? JSON.stringify([peer.rejoins ?? 0, peer.schema, peer.serves?.slice().sort()])
      : null;
    if (connection !== watcher.connection || (refresh && connection !== null)) {
      reset(watcher, connection);
    }
  }
}

function listenForAccess() {
  let live = true;
  let roomTold = false;
  let account: string | null | undefined;
  const offRoom = ipcListen("remote", "roomChanged", (next) => {
    roomTold = true;
    applyRoom(next);
  });
  const offAccount = ipcListen("remote", "accountChanged", (next) => {
    const id =
      next.status === "signed-in"
        ? JSON.stringify([next.server, next.user.id, next.device.id])
        : null;
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
    access: null,
  };
  watched.set(deviceId, peer);
  const off = peer.listeners.subscribe(notify);
  stopWatching ??= listenForAccess();
  applyRoom(room);
  return () => {
    off();
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

export function usePeerChatAccess(deviceId: string, visible: boolean): Access | null {
  const subscribe = useCallback(
    (notify: () => void) => watchPeerChatAccess(deviceId, notify),
    [deviceId],
  );
  const snapshot = useCallback(
    () => (visible ? peerChatAccess(deviceId) : null),
    [deviceId, visible],
  );
  return useSyncExternalStore(subscribe, snapshot);
}
