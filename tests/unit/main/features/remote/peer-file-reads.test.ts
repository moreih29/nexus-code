import { describe, expect, test } from "bun:test";
import {
  MAX_BYTES_CHUNK,
  RpcErrorCode,
  type RpcParams,
} from "../../../../../packages/remote-protocol/src";
import { PeerFileGrants } from "../../../../../src/main/features/remote/peer-file-grants";
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

  test("a picture at the same path revalidates and only transfers changed bytes", async () => {
    let version = "v1";
    const downloads: string[] = [];
    const cache = new PeerFileReads(async (_device, request) => {
      if (request.ifVersion === version) return { kind: "notModified", version };
      const data = version === "v1" ? "AAA=" : "BBB=";
      downloads.push(data);
      return { kind: "image", path: request.path, mediaType: "image/png", data, size: 2, version };
    });
    cache.updateRoom(room());
    const read = () => cache.read(PEER, "same.png", {});
    const first = await read();
    expect(await read()).toBe(first);
    version = "v2";
    const second = await read();
    expect(second).toMatchObject({ kind: "image", data: "BBB=" });
    expect(await read()).toBe(second);
    expect(downloads).toEqual(["AAA=", "BBB="]);
  });

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

describe("reads of files the user opened through a grant", () => {
  const TOKEN = "t".repeat(43);
  const NEXT = "n".repeat(43);
  const answer = { kind: "answer", itemKey: "a-1" } as const;
  const grantsRoom = (): RoomState => ({
    status: "online",
    peers: [
      {
        id: PEER.deviceId,
        name: "peer",
        platform: "linux",
        online: true,
        schema: "0.40.0",
        rejoins: 0,
        serves: ["chat.read", "files", "files.grants"],
      },
    ],
  });

  function granted(
    fail: (args: RpcParams<"files.read">, attempt: number) => RpcFailure | null = () => null,
  ) {
    const reads: RpcParams<"files.read">[] = [];
    const grantCalls: RpcParams<"files.grant">[] = [];
    let token = TOKEN;
    const grants = new PeerFileGrants({
      grant: async (_device, params) => {
        grantCalls.push(params);
        return { path: "/o/qa.txt", grant: token };
      },
      resolve: async () => ({ found: [] }),
    });
    const cache = new PeerFileReads(
      async (_device, args) => {
        reads.push(args);
        const failure = fail(args, reads.length);
        if (failure) throw failure;
        return {
          kind: "text",
          path: args.path,
          text: "hello",
          size: 5,
          ...(args.versioned || args.ifVersion ? { version: "v1" } : {}),
        };
      },
      undefined,
      grants,
    );
    cache.updateRoom(grantsRoom());
    return {
      cache,
      grants,
      reads,
      grantCalls,
      renewWith: (next: string) => {
        token = next;
      },
    };
  }

  test("only a path with a grant carries its token", async () => {
    const { cache, grants, reads } = granted();
    await grants.grant(PEER, "t1", { href: "/o/qa.txt", source: answer }, "open");
    await cache.read(PEER, "/o/qa.txt", { as: "text" });
    await cache.read(PEER, "/w/inside.txt", { as: "text" });
    expect(reads.map((r) => [r.path, r.grant])).toEqual([
      ["/o/qa.txt", TOKEN],
      ["/w/inside.txt", undefined],
    ]);
  });

  test("an expired grant is asked for again once, then the read is tried again", async () => {
    const { cache, grants, reads, grantCalls, renewWith } = granted((args) =>
      args.grant === TOKEN ? new RpcFailure(RpcErrorCode.GrantExpired, "grant expired") : null,
    );
    await grants.grant(PEER, "t1", { href: "/o/qa.txt", source: answer }, "open");
    renewWith(NEXT);
    const read = await cache.read(PEER, "/o/qa.txt", { as: "text" });
    expect(read.kind).toBe("text");
    expect(reads.map((r) => r.grant)).toEqual([TOKEN, NEXT]);
    expect(grantCalls).toHaveLength(2);
    expect(grantCalls[1]).toEqual(grantCalls[0]);
  });

  test("a grant that keeps expiring is asked for only once per read", async () => {
    const { cache, grants, reads, grantCalls } = granted(
      () => new RpcFailure(RpcErrorCode.GrantExpired, "grant expired"),
    );
    await grants.grant(PEER, "t1", { href: "/o/qa.txt", source: answer }, "open");
    await expect(cache.read(PEER, "/o/qa.txt", { as: "text" })).rejects.toMatchObject({
      code: RpcErrorCode.GrantExpired,
    });
    expect(reads).toHaveLength(2);
    expect(grantCalls).toHaveLength(2);
  });

  test("a file that now needs a grant is asked for again only after a click", async () => {
    const required = () =>
      new RpcFailure(RpcErrorCode.Forbidden, "a grant is required", { grant: "required" });
    const { cache, grants, reads, grantCalls } = granted((args) =>
      args.grant ? null : required(),
    );
    await expect(cache.read(PEER, "/o/qa.txt", { as: "text" })).rejects.toMatchObject({
      data: { grant: "required" },
    });
    expect(grantCalls).toEqual([]);
    await grants.grant(PEER, "t1", { href: "/o/qa.txt", source: answer }, "open");
    expect((await cache.read(PEER, "/o/qa.txt", { as: "text" })).kind).toBe("text");
    expect(reads.map((r) => r.grant)).toEqual([undefined, TOKEN]);
  });

  test("an invalid grant is dropped and not asked for again", async () => {
    const { cache, grants, grantCalls } = granted(
      () => new RpcFailure(RpcErrorCode.Forbidden, "grant invalid", { grant: "invalid" }),
    );
    await grants.grant(PEER, "t1", { href: "/o/qa.txt", source: answer }, "open");
    await expect(cache.read(PEER, "/o/qa.txt", { as: "text" })).rejects.toMatchObject({
      data: { grant: "invalid" },
    });
    expect(grantCalls).toHaveLength(1);
    expect(grants.holds(PEER, "/o/qa.txt")).toBe(false);
  });

  test("a read with a grant does not share a request or a cached answer with one without", async () => {
    const { cache, grants, reads } = granted();
    await cache.read(PEER, "/o/qa.txt", { as: "text" });
    await grants.grant(PEER, "t1", { href: "/o/qa.txt", source: answer }, "open");
    await cache.read(PEER, "/o/qa.txt", { as: "text" });
    expect(reads.map((r) => [r.grant, r.versioned, r.ifVersion])).toEqual([
      [undefined, true, undefined],
      [TOKEN, true, undefined],
    ]);
  });

  test("after a rejoin the device can be asked for grants again, with none kept", async () => {
    const { cache, grants, reads } = granted();
    await grants.grant(PEER, "t1", { href: "/o/qa.txt", source: answer }, "open");
    const rejoined = grantsRoom();
    cache.updateRoom({
      ...rejoined,
      peers: rejoined.peers.map((peer) => ({ ...peer, rejoins: 1 })),
    });
    expect(grants.holds(PEER, "/o/qa.txt")).toBe(false);
    await grants.grant(PEER, "t1", { href: "/o/qa.txt", source: answer }, "open");
    await cache.read(PEER, "/o/qa.txt", { as: "text" });
    expect(reads.map((r) => r.grant)).toEqual([TOKEN]);
  });

  test("a presence probe reads one byte with no version", async () => {
    const { cache, reads } = granted();
    await cache.read(PEER, "/w/a.txt", { as: "text", length: 1 }, undefined, true);
    expect(reads[0]).toEqual({ workspaceId: "ws", path: "/w/a.txt", as: "text", length: 1 });
  });
});
