import { describe, expect, test } from "bun:test";
import {
  MAX_BYTES_CHUNK,
  RpcErrorCode,
  type RpcParams,
} from "../../../../../packages/remote-protocol/src";
import { PeerFileReads } from "../../../../../src/main/features/remote/peer-file-reads";
import { RpcFailure } from "../../../../../src/main/features/remote/room";
import type { RoomState } from "../../../../../src/shared/remote/room";

const PEER = { deviceId: "device", workspaceId: "ws" };
const shape = { as: "bytes", offset: 0, length: 8 } as const;

function room(schema = "0.13.4", rejoins = 0): RoomState {
  return {
    status: "online",
    peers: [{ id: PEER.deviceId, name: "peer", platform: "linux", online: true, schema, rejoins }],
  };
}

function fixture(limits?: ConstructorParameters<typeof PeerFileReads>[1]) {
  const requests: RpcParams<"files.read">[] = [];
  let bytes = 0;
  let fail = false;
  const version = "v1";
  const cache = new PeerFileReads(async (_device, args) => {
    requests.push(args);
    if (fail) throw new RpcFailure(RpcErrorCode.Forbidden, "grant revoked");
    if (args.ifVersion === version) return { kind: "notModified", version };
    if (args.requireVersion && args.requireVersion !== version)
      throw new RpcFailure(RpcErrorCode.InvalidParams, "file version changed");
    const size = 1024;
    const offset = args.offset ?? 0;
    const data = Buffer.alloc(
      Math.max(0, Math.min(args.length ?? MAX_BYTES_CHUNK, size - offset)),
      65,
    );
    bytes += data.length;
    return {
      kind: "bytes",
      path: args.path,
      data: data.toString("base64"),
      offset,
      size,
      ...(args.versioned || args.ifVersion || args.requireVersion ? { version } : {}),
    };
  }, limits);
  cache.updateRoom(room());
  return {
    cache,
    requests,
    totals: () => [requests.length, bytes],
    allow: (allow: boolean) => {
      fail = !allow;
    },
  };
}

describe("the shared desktop peer file cache", () => {
  for (const [limit, limits] of [
    ["entry", { entries: 2, bytes: 10_000, fileBytes: 2048 }],
    ["byte", { entries: 10, bytes: 360, fileBytes: 2048 }],
  ] as const) {
    test(`uses LRU order under the ${limit} budget`, async () => {
      const { cache, totals, requests } = fixture(limits);
      for (const path of ["a", "b", "a", "c", "a", "b"]) await cache.read(PEER, path, shape);
      expect(totals()).toEqual([6, 32]);
      expect(requests.map((r) => r.ifVersion)).toEqual([
        undefined,
        undefined,
        "v1",
        undefined,
        "v1",
        undefined,
      ]);
    });
  }

  test("denial evicts data and every reopen needs authorization", async () => {
    const { cache, allow, totals, requests } = fixture();
    await cache.read(PEER, "x", shape);
    allow(false);
    await expect(cache.read(PEER, "x", shape)).rejects.toThrow("grant revoked");
    allow(true);
    await cache.read(PEER, "x", shape);
    expect(totals()).toEqual([3, 16]);
    expect(requests.map((r) => r.ifVersion)).toEqual([undefined, "v1", undefined]);
  });

  test("scopes contents by workspace and clears on disconnect", async () => {
    const { cache, requests, totals } = fixture();
    await cache.read(PEER, "x", shape);
    await cache.read({ ...PEER, workspaceId: "elsewhere" }, "x", shape);
    cache.updateRoom({ status: "waiting", peers: [] });
    await expect(cache.read(PEER, "x", shape)).rejects.toThrow("not in the room");
    cache.updateRoom(room());
    await cache.read(PEER, "x", shape);
    expect(totals()).toEqual([3, 24]);
    expect(requests.every((r) => r.ifVersion === undefined)).toBe(true);
  });

  test("legacy peers get their original requests and transfer bytes on every reopen", async () => {
    const { cache, requests, totals } = fixture();
    cache.updateRoom(room("0.13.3"));
    for (let i = 0; i < 2; i++) await cache.read(PEER, "x", shape);
    expect(totals()).toEqual([2, 16]);
    expect(requests).toEqual(
      Array.from({ length: 2 }, () => ({ ...shape, path: "x", workspaceId: "ws" })),
    );
  });

  test("coalesces simultaneous opens and cancels only the last waiter", async () => {
    const pending: { signal: AbortSignal; resolve: () => void }[] = [];
    const cache = new PeerFileReads(
      (_device, args, signal) =>
        new Promise((resolve) => {
          pending.push({
            signal,
            resolve: () =>
              resolve({
                kind: "bytes",
                offset: 0,
                size: 8,
                path: args.path,
                data: "AAAAAAAAAAA=",
                version: "v1",
              }),
          });
        }),
    );
    cache.updateRoom(room());
    const one = new AbortController();
    const first = cache.read(PEER, "x", shape, one.signal);
    const second = cache.read(PEER, "x", shape);
    expect(pending.length).toBe(1);
    one.abort();
    await expect(first).rejects.toHaveProperty("name", "AbortError");
    expect(pending[0]?.signal.aborted).toBe(false);
    pending[0]?.resolve();
    expect((await second).version).toBe("v1");
    const two = new AbortController();
    const alone = cache.read(PEER, "y", shape, two.signal);
    two.abort();
    await expect(alone).rejects.toHaveProperty("name", "AbortError");
    expect(pending[1]?.signal.aborted).toBe(true);
    pending[1]?.resolve();
  });

  test("a rejoin neither joins the old flight nor accepts its late reply", async () => {
    const pending: Array<(version: string) => void> = [];
    const cache = new PeerFileReads(
      (_device, args) =>
        new Promise((resolve) => {
          pending.push((version) =>
            resolve({
              kind: "bytes",
              offset: 0,
              size: 8,
              path: args.path,
              data: "AAAAAAAAAAA=",
              version,
            }),
          );
        }),
    );
    cache.updateRoom(room());
    const first = cache.read(PEER, "x", shape);
    cache.updateRoom(room("0.13.4", 1));
    const next = cache.read(PEER, "x", shape);
    expect(pending.length).toBe(2);
    pending[1]?.("new");
    expect((await next).version).toBe("new");
    pending[0]?.("old");
    await expect(first).rejects.toHaveProperty("name", "AbortError");
  });
});

test("32 concurrent PDF spans and 64 relay RPCs fit the working-set limits", async () => {
  const { resolve, promise } = Promise.withResolvers<void>();
  let calls = 0;
  const size = MAX_BYTES_CHUNK + 1;
  const first = Buffer.alloc(MAX_BYTES_CHUNK, 1).toString("base64");
  const cache = new PeerFileReads(async (_device, args) => {
    calls++;
    await promise;
    const offset = args.offset ?? 0;
    return { kind: "bytes", offset, size, data: offset === 0 ? first : "AQ==", path: args.path };
  });
  cache.updateRoom(room("0.13.2"));
  const spans = Array.from({ length: 32 }, (_, i) =>
    cache.readBytes(PEER, `pdf-${i}`, 0, size, false),
  );
  expect(calls).toBe(64);
  await expect(cache.readBytes(PEER, "over-capacity", 0, size, false)).rejects.toThrow("too many");
  resolve();
  expect(
    (await Promise.all(spans)).every((span) => span.parts.length === 2 && span.size === size),
  ).toBe(true);
  expect((await cache.readBytes(PEER, "after", 0, size, false)).parts.length).toBe(2);
});

test("a mutable image IPC read preserves its shape and really authorizes each reopen", async () => {
  const image = {
    kind: "image",
    path: "/pic.png",
    mediaType: "image/png",
    data: "AQID",
    size: 3,
    version: "image-v1",
  } as const;
  const params: RpcParams<"files.read">[] = [];
  const cache = new PeerFileReads(async (_device, args) => {
    params.push(args);
    return args.ifVersion === image.version
      ? { kind: "notModified", version: image.version }
      : image;
  });
  cache.updateRoom(room());
  expect(await cache.read(PEER, image.path, {})).toEqual(image);
  expect(await cache.read(PEER, image.path, {})).toEqual(image);
  expect(params.map((r) => r.ifVersion)).toEqual([undefined, image.version]);
});
