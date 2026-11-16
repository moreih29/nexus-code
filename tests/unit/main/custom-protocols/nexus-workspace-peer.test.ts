// The peer branch of the nexus-workspace:// protocol handler: another
// computer's file, read through the room a piece at a time, for quick look
// over that computer's chat.

import { describe, expect, mock, test } from "bun:test";
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

/** A file of `size` bytes, each its offset's low byte, read as the room reads it. */
function fileOf(size: number) {
  const asked: { peer: PeerWorkspace; path: string; offset: number; length: number }[] = [];
  const read = async (peer: PeerWorkspace, path: string, offset: number, length: number) => {
    asked.push({ peer, path, offset, length });
    const end = Math.min(size, offset + length);
    const bytes = Buffer.alloc(Math.max(0, end - offset));
    for (let i = 0; i < bytes.length; i++) bytes[i] = (offset + i) & 0xff;
    return { base64: bytes.toString("base64"), size };
  };
  return { read, asked };
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
    // A segment that decodes to a separator; that computer keeps reads to its folders besides.
    const climbing = "nexus-workspace://peer/dev-1/ws-1/home/%2E%2E%2Fetc/passwd";
    expect((await handler(new Request(climbing))).status).toBe(404);
    expect((await handler(new Request("nexus-workspace://peer/dev-1/ws-1/"))).status).toBe(404);
    expect((await handler(new Request("nexus-workspace://peer/dev:1/ws-1/a"))).status).toBe(404);
    expect(file.asked).toEqual([]);
  });
});
