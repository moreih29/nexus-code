// Byte ranges from the nexus-workspace:// protocol, which <audio> and
// <video> ask for to play a file as it loads and to seek it.

import { afterAll, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FsProvider } from "../../../../src/main/features/fs/bridge/provider";
import type { WorkspaceManager } from "../../../../src/main/features/workspace/manager";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";

// The local branch's whole-file path goes through net.fetch, which a range
// never reaches; it fails here so a test that fell through to it would show.
mock.module("electron", () => ({
  net: { fetch: mock(() => Promise.resolve(new Response(null, { status: 500 }))) },
  protocol: {
    registerSchemesAsPrivileged: mock(() => {}),
    handle: mock(() => {}),
  },
}));

const { buildNexusWorkspaceHandler, requestedRange } = await import(
  "../../../../src/main/features/custom-protocols/nexus-workspace"
);

const BYTES = Buffer.from("0123456789");

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-range-")));
fs.writeFileSync(path.join(root, "clip.mp4"), BYTES);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function manager(meta: Partial<WorkspaceMeta>, fsProvider?: Partial<FsProvider>): WorkspaceManager {
  return {
    list: () => [{ id: "ws", name: "w", pinned: false, tabs: [], ...meta }],
    getFs: async () => fsProvider as FsProvider,
  } as unknown as WorkspaceManager;
}

const local = buildNexusWorkspaceHandler(
  manager({
    rootPath: root,
    location: { kind: "local", rootPath: root },
  } as Partial<WorkspaceMeta>),
);
const ssh = buildNexusWorkspaceHandler(
  manager(
    {
      rootPath: "/home/u/p",
      location: { kind: "ssh", host: "h", user: "u", remotePath: "/home/u/p" },
    } as Partial<WorkspaceMeta>,
    {
      kind: "ssh",
      readBinary: async () => ({
        kind: "ok",
        base64: BYTES.toString("base64"),
        sizeBytes: BYTES.length,
        mtime: "2026-01-01T00:00:00.000Z",
      }),
    },
  ),
);

function ask(range: string): Request {
  return new Request("nexus-workspace://ws/clip.mp4", { headers: { Range: range } });
}

describe("requestedRange", () => {
  test("reads a start and end, an open end, and a suffix", () => {
    expect(requestedRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
    expect(requestedRange("bytes=4-", 10)).toEqual({ start: 4, end: 9 });
    expect(requestedRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(requestedRange("bytes=8-100", 10)).toEqual({ start: 8, end: 9 });
    expect(requestedRange("bytes=-100", 10)).toEqual({ start: 0, end: 9 });
  });

  test("is the whole file for no header, several ranges, or one it cannot read", () => {
    expect(requestedRange(null, 10)).toBeNull();
    expect(requestedRange("bytes=0-1,4-5", 10)).toBeNull();
    expect(requestedRange("items=0-1", 10)).toBeNull();
    expect(requestedRange("bytes=5-2", 10)).toBeNull();
    expect(requestedRange("bytes=-", 10)).toBeNull();
  });

  test("is unsatisfiable past the end, for no bytes, or of an empty file", () => {
    expect(requestedRange("bytes=10-", 10)).toBe("unsatisfiable");
    expect(requestedRange("bytes=-0", 10)).toBe("unsatisfiable");
    expect(requestedRange("bytes=0-", 0)).toBe("unsatisfiable");
  });
});

for (const [name, handler] of [
  ["local", local],
  ["ssh", ssh],
] as const) {
  describe(`nexus-workspace:// ranges (${name})`, () => {
    test("serves the bytes asked for as a 206", async () => {
      const resp = await handler(ask("bytes=2-5"));
      expect(resp.status).toBe(206);
      expect(resp.headers.get("Content-Range")).toBe("bytes 2-5/10");
      expect(resp.headers.get("Content-Length")).toBe("4");
      expect(resp.headers.get("Content-Type")).toBe("video/mp4");
      expect(resp.headers.get("Accept-Ranges")).toBe("bytes");
      expect(await resp.text()).toBe("2345");
    });

    test("serves to the end for an open range", async () => {
      const resp = await handler(ask("bytes=7-"));
      expect(resp.status).toBe(206);
      expect(await resp.text()).toBe("789");
    });

    test("answers 416 with the size for a range past the end", async () => {
      const resp = await handler(ask("bytes=20-"));
      expect(resp.status).toBe(416);
      expect(resp.headers.get("Content-Range")).toBe("bytes */10");
    });
  });
}
