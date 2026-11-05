// SSH branch of the nexus-workspace:// protocol handler.
//
// The local-disk path is covered implicitly by the existing markdown image
// preview suite; these tests focus on the new agent-relayed path that v1
// previously rejected with 404. We mock the WorkspaceManager surface that
// buildNexusWorkspaceHandler actually consumes (`list` + `getFs`), which is
// narrow enough that the cast keeps the test honest without dragging the
// whole manager + agent lifecycle into the test.

import { describe, expect, mock, test } from "bun:test";
import type { FsProvider } from "../../../../src/main/features/fs/bridge/provider";
import type { WorkspaceManager } from "../../../../src/main/features/workspace/manager";
import { READ_RANGE_MAX_BYTES } from "../../../../src/shared/fs/defaults";
import type { FileReadBinaryResult } from "../../../../src/shared/fs/types";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";

// `nexus-workspace.ts` imports `protocol` and `net` from Electron at module
// load time (for the public wiring entry points). In Bun the real electron
// runtime isn't available — mock the minimal surface so the import resolves.
// The SSH branch under test never calls into either symbol; only the local
// branch's `net.fetch` would, and these tests don't exercise that.
mock.module("electron", () => ({
  net: { fetch: mock(() => Promise.resolve(new Response(null, { status: 500 }))) },
  protocol: {
    registerSchemesAsPrivileged: mock(() => {}),
    handle: mock(() => {}),
  },
}));

// Dynamic import after the mock so the static import isn't hoisted ahead of it.
const { buildNexusWorkspaceHandler } = await import(
  "../../../../src/main/features/custom-protocols/nexus-workspace"
);

const SSH_META = {
  id: "ws-ssh",
  name: "remote",
  rootPath: "/home/user/proj",
  location: {
    kind: "ssh" as const,
    host: "example.com",
    user: "user",
    remotePath: "/home/user/proj",
  },
  pinned: false,
  sortOrder: 0,
  pinnedSortOrder: 0,
  tabs: [],
} as unknown as WorkspaceMeta;

type ReadRange = (rel: string, offset: number, length: number) => Promise<FileReadBinaryResult>;

function makeManager(readRange: ReadRange): WorkspaceManager {
  const fsProvider: Partial<FsProvider> & { kind: "ssh" } = {
    kind: "ssh",
    readRange,
  };
  return {
    list: () => [SSH_META],
    getFs: async () => fsProvider as FsProvider,
  } as unknown as WorkspaceManager;
}

describe("nexus-workspace:// SSH branch", () => {
  test("serves agent-returned bytes as the response body with the right Content-Type", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const base64 = Buffer.from(bytes).toString("base64");
    const handler = buildNexusWorkspaceHandler(
      makeManager(async (rel, offset) => {
        expect(rel).toBe("docs/logo.png"); // posix-style on the wire
        expect(offset).toBe(0);
        return { kind: "ok", base64, sizeBytes: bytes.length, mtime: "2026-01-01T00:00:00.000Z" };
      }),
    );

    const resp = await handler(new Request("nexus-workspace://ws-ssh/docs/logo.png"));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("image/png");
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
    expect(resp.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(resp.headers.get("Content-Length")).toBe(String(bytes.length));
    const body = new Uint8Array(await resp.arrayBuffer());
    expect(Array.from(body)).toEqual(Array.from(bytes));
  });

  test("returns 404 when the agent reports the file missing", async () => {
    const handler = buildNexusWorkspaceHandler(
      makeManager(async () => ({ kind: "missing", reason: "not-found" })),
    );
    const resp = await handler(new Request("nexus-workspace://ws-ssh/absent.jpg"));
    expect(resp.status).toBe(404);
  });

  test("returns 404 when readRange throws (transport or auth failure)", async () => {
    const handler = buildNexusWorkspaceHandler(
      makeManager(async () => {
        throw new Error("ssh.unauthorised");
      }),
    );
    const resp = await handler(new Request("nexus-workspace://ws-ssh/x.png"));
    expect(resp.status).toBe(404);
  });

  test("returns 503 when the workspace fs is not yet wired", async () => {
    const manager = {
      list: () => [SSH_META],
      getFs: async () => {
        throw new Error("agent fs provider: channel not yet wired");
      },
    } as unknown as WorkspaceManager;
    const handler = buildNexusWorkspaceHandler(manager);
    const resp = await handler(new Request("nexus-workspace://ws-ssh/x.png"));
    expect(resp.status).toBe(503);
  });

  test("still returns 404 for unknown workspaces regardless of branch", async () => {
    const handler = buildNexusWorkspaceHandler(
      makeManager(async () => ({ kind: "missing", reason: "not-found" })),
    );
    const resp = await handler(new Request("nexus-workspace://ws-unknown/x.png"));
    expect(resp.status).toBe(404);
  });
});

describe("nexus-workspace:// SSH branch, a file larger than one read", () => {
  const PIECE = READ_RANGE_MAX_BYTES;
  const SIZE = PIECE * 3 + 5;
  const file = Buffer.alloc(SIZE, 0);
  for (let i = 0; i < SIZE; i++) file[i] = i % 251;
  const MTIME = "2026-01-01T00:00:00.000Z";

  /** A file read as the agent reads it; `mtime` is what each read says of it. */
  function agentFile(mtime: (offset: number) => string = () => MTIME) {
    const reads: Array<[number, number]> = [];
    const readRange: ReadRange = async (_rel, offset, length) => {
      reads.push([offset, length]);
      const bytes = file.subarray(offset, offset + Math.min(length, PIECE));
      return {
        kind: "ok",
        base64: bytes.toString("base64"),
        sizeBytes: SIZE,
        mtime: mtime(offset),
      };
    };
    return { reads, handler: buildNexusWorkspaceHandler(makeManager(readRange)) };
  }

  test("is served whole in pieces of one read each", async () => {
    const { reads, handler } = agentFile();
    const resp = await handler(new Request("nexus-workspace://ws-ssh/big.mp4"));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Length")).toBe(String(SIZE));
    expect(Buffer.from(await resp.arrayBuffer()).equals(file)).toBe(true);
    expect(reads).toEqual([
      [0, PIECE],
      [PIECE, PIECE],
      [PIECE * 2, PIECE],
      [PIECE * 3, 5],
    ]);
  });

  test("a range is read from where it starts, and only its bytes", async () => {
    const { reads, handler } = agentFile();
    const from = PIECE + 10;
    const to = PIECE * 2 + 20;
    const resp = await handler(
      new Request("nexus-workspace://ws-ssh/big.mp4", {
        headers: { Range: `bytes=${from}-${to}` },
      }),
    );
    expect(resp.status).toBe(206);
    expect(resp.headers.get("Content-Range")).toBe(`bytes ${from}-${to}/${SIZE}`);
    expect(Buffer.from(await resp.arrayBuffer()).equals(file.subarray(from, to + 1))).toBe(true);
    expect(reads).toEqual([
      [from, PIECE],
      [from + PIECE, to + 1 - from - PIECE],
    ]);
  });

  test("reads only a few pieces ahead of what is taken, and stops when cancelled", async () => {
    const { reads, handler } = agentFile();
    const resp = await handler(new Request("nexus-workspace://ws-ssh/big.mp4"));
    const reader = resp.body?.getReader();
    expect((await reader?.read())?.value?.length).toBe(PIECE);
    const asked = reads.length;
    expect(asked).toBeLessThanOrEqual(4);
    await reader?.cancel();
    await Bun.sleep(0);
    expect(reads.length).toBe(asked);
  });

  test("a file changed while it is read fails the response's body", async () => {
    const { handler } = agentFile((offset) =>
      offset >= PIECE * 2 ? "2026-01-02T00:00:00.000Z" : MTIME,
    );
    const resp = await handler(new Request("nexus-workspace://ws-ssh/big.mp4"));
    expect(resp.status).toBe(200);
    await expect(resp.arrayBuffer()).rejects.toThrow("big.mp4 changed while it was read");
  });
});
