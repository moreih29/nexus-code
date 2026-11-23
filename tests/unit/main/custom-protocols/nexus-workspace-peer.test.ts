import { describe, expect, mock, test } from "bun:test";
import { PeerFileReads } from "../../../../src/main/features/remote/peer-file-reads";
import type { WorkspaceManager } from "../../../../src/main/features/workspace/manager";
import type { PeerWorkspace } from "../../../../src/shared/fs/peer-url";

mock.module("electron", () => ({
  net: { fetch: mock(() => Promise.resolve(new Response(null, { status: 500 }))) },
  protocol: {
    registerSchemesAsPrivileged: mock(() => {}),
    handle: mock(() => {}),
  },
}));

const { buildNexusWorkspaceHandler, PEER_PIECE_BYTES } = await import(
  "../../../../src/main/features/custom-protocols/nexus-workspace"
);
const { buildPeerUrl } = await import("../../../../src/shared/fs/peer-url");

const manager = { list: () => [], getFs: async () => null } as unknown as WorkspaceManager;
const PEER = { deviceId: "dev-1", workspaceId: "ws-1" };

function fileOf(size: number) {
  const asked: { peer: PeerWorkspace; path: string; offset: number; length: number }[] = [];
  const read = async (peer: PeerWorkspace, path: string, offset: number, length: number) => {
    asked.push({ peer, path, offset, length });
    const end = Math.min(size, offset + length);
    const bytes = Buffer.alloc(Math.max(0, end - offset));
    for (let i = 0; i < bytes.length; i++) bytes[i] = (offset + i) & 0xff;
    return { data: bytes.toString("base64"), size };
  };
  return {
    read: async (peer: PeerWorkspace, path: string, offset: number, length: number) => ({
      first: await read(peer, path, offset, length),
      read: (at: number, count: number) => read(peer, path, at, count),
    }),
    asked,
  };
}

describe("nexus-workspace:// another computer's file", () => {
  test("is read through the room by its path there, in pieces the protocol takes", async () => {
    const size = PEER_PIECE_BYTES + 10;
    const file = fileOf(size);
    const handler = buildNexusWorkspaceHandler(manager, () => file.read);
    const res = await handler(new Request(buildPeerUrl(PEER, "/home/me/My Clip.mov")));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("video/quicktime");
    expect(res.headers.get("Content-Length")).toBe(String(size));
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(size);
    expect(body[PEER_PIECE_BYTES + 3]).toBe((PEER_PIECE_BYTES + 3) & 0xff);
    expect(file.asked.every((a) => a.path === "/home/me/My Clip.mov")).toBe(true);
    expect(file.asked.every((a) => a.length <= PEER_PIECE_BYTES)).toBe(true);
    expect(file.asked[0]?.peer).toEqual(PEER);
  });

  test("a Windows path from its drive, and a range from where a video seeks", async () => {
    const file = fileOf(1000);
    const handler = buildNexusWorkspaceHandler(manager, () => file.read);
    const res = await handler(
      new Request(buildPeerUrl(PEER, "C:\\Users\\me\\clip.mp4"), {
        headers: { range: "bytes=100-199" },
      }),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 100-199/1000");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(100);
    expect(body[0]).toBe(100);
    expect(file.asked[0]?.path).toBe("C:/Users/me/clip.mp4");
    expect(file.asked[0]?.offset).toBe(100);
  });

  test("none there, or no room to ask through, is not found", async () => {
    const gone = buildNexusWorkspaceHandler(manager, () => async () => "missing" as const);
    expect((await gone(new Request(buildPeerUrl(PEER, "/a.png")))).status).toBe(404);
    const away = buildNexusWorkspaceHandler(manager, () => null);
    expect((await away(new Request(buildPeerUrl(PEER, "/a.png")))).status).toBe(404);
    const failing = buildNexusWorkspaceHandler(manager, () => async () => {
      throw new Error("not in the room");
    });
    expect((await failing(new Request(buildPeerUrl(PEER, "/a.png")))).status).toBe(404);
  });

  test("a path that climbs out, or names no file, is refused unasked", async () => {
    const file = fileOf(10);
    const handler = buildNexusWorkspaceHandler(manager, () => file.read);
    const climbing = "nexus-workspace://peer/dev-1/ws-1/home/%2E%2E%2Fetc/passwd";
    expect((await handler(new Request(climbing))).status).toBe(404);
    expect((await handler(new Request("nexus-workspace://peer/dev-1/ws-1/"))).status).toBe(404);
    expect((await handler(new Request("nexus-workspace://peer/dev:1/ws-1/a"))).status).toBe(404);
    expect(file.asked).toEqual([]);
  });
});

test("the protocol shares byte spans with IPC and validates a warm range", async () => {
  const bytes = Buffer.alloc(PEER_PIECE_BYTES + 23, 65);
  let version = "a";
  let requests = 0;
  let downloaded = 0;
  const cache = new PeerFileReads(async (_device, args) => {
    requests++;
    if (args.ifVersion === version) return { kind: "notModified", version };
    const at = args.offset ?? 0;
    const chunk = bytes.subarray(at, at + (args.length ?? PEER_PIECE_BYTES));
    downloaded += chunk.length;
    return {
      kind: "bytes",
      data: chunk.toString("base64"),
      path: args.path,
      offset: at,
      size: bytes.length,
      version,
    };
  });
  cache.updateRoom({
    status: "online",
    peers: [{ id: PEER.deviceId, name: "host", platform: "linux", online: true, schema: "0.13.4" }],
  });
  const path = "/w/photo.png";
  await cache.readBytes(PEER, path, 0, PEER_PIECE_BYTES, true);
  const handler = buildNexusWorkspaceHandler(manager, () => cache.openBytes.bind(cache));
  const request = () =>
    new Request(buildPeerUrl(PEER, path), { headers: { range: "bytes=100-199" } });
  const first = await handler(request());
  expect(first.status).toBe(206);
  expect(first.headers.get("Cache-Control")).toBe("no-store");
  expect(Buffer.from(await first.arrayBuffer())).toEqual(bytes.subarray(100, 200));
  expect([requests, downloaded]).toEqual([3, bytes.length]);

  bytes.fill(66);
  version = "b";
  const changed = await handler(request());
  expect(Buffer.from(await changed.arrayBuffer())).toEqual(bytes.subarray(100, 200));
  expect([requests, downloaded]).toEqual([4, bytes.length + 100]);
});

test("cancel stops peer protocol read-ahead", async () => {
  const fetched: number[] = [];
  let signal: AbortSignal | undefined;
  const handler = buildNexusWorkspaceHandler(
    manager,
    () => async (_peer, _path, _offset, length, lifetime) => {
      signal = lifetime;
      return {
        first: { data: Buffer.alloc(length).toString("base64"), size: 20 * length },
        read: (at) => {
          fetched.push(at);
          return new Promise((_resolve, reject) => {
            lifetime.addEventListener("abort", () => reject(lifetime.reason), { once: true });
          });
        },
      };
    },
  );
  const response = await handler(new Request(buildPeerUrl(PEER, "/w/clip.mp4")));
  const body = response.body?.getReader();
  expect((await body?.read())?.value?.length).toBe(PEER_PIECE_BYTES);
  expect(fetched.length).toBeLessThanOrEqual(3);
  await body?.cancel();
  expect(signal?.aborted).toBe(true);
  expect(fetched.length).toBeLessThanOrEqual(3);
});

test("suffix ranges fetch metadata and only the requested content on a versioned host", async () => {
  const calls: number[] = [];
  const size = 2 * PEER_PIECE_BYTES;
  const cache = new PeerFileReads(async (_device, args) => {
    const length = args.length ?? PEER_PIECE_BYTES;
    calls.push(length);
    return {
      kind: "bytes",
      data: Buffer.alloc(length, 77).toString("base64"),
      path: args.path,
      offset: args.offset ?? 0,
      size,
      version: "v1",
    };
  });
  cache.updateRoom({
    status: "online",
    peers: [{ id: PEER.deviceId, name: "host", platform: "linux", online: true, schema: "0.13.4" }],
  });
  const handler = buildNexusWorkspaceHandler(manager, () => cache.openBytes.bind(cache));
  const response = await handler(
    new Request(buildPeerUrl(PEER, "/w/clip.mp4"), { headers: { range: "bytes=-100" } }),
  );
  expect(response.status).toBe(206);
  expect(response.headers.get("Content-Range")).toBe(`bytes ${size - 100}-${size - 1}/${size}`);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.alloc(100, 77));
  expect(calls).toEqual([0, 100]);
});

test("disconnect invalidates an open peer response before buffered bytes can be delivered", async () => {
  const cache = new PeerFileReads(async (_device, args) => ({
    kind: "bytes",
    data: "AQID",
    offset: 0,
    size: 3,
    path: args.path,
    version: "v1",
  }));
  cache.updateRoom({
    status: "online",
    peers: [{ id: PEER.deviceId, name: "host", platform: "linux", online: true, schema: "0.13.4" }],
  });
  const handler = buildNexusWorkspaceHandler(manager, () => cache.openBytes.bind(cache));
  const response = await handler(new Request(buildPeerUrl(PEER, "/w/photo.png")));
  cache.updateRoom({ status: "waiting", peers: [] });
  await expect(response.arrayBuffer()).rejects.toHaveProperty("name", "AbortError");
});
