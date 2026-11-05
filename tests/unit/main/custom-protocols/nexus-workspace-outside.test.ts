// Files outside a workspace that a Claude tab linked, over the
// nexus-workspace://<id>.outside/<absolute path> host.

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FsProvider } from "../../../../src/main/features/fs/bridge/provider";
import type { WorkspaceManager } from "../../../../src/main/features/workspace/manager";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";

mock.module("electron", () => ({
  net: { fetch: mock(() => Promise.resolve(new Response(null, { status: 500 }))) },
  protocol: {
    registerSchemesAsPrivileged: mock(() => {}),
    handle: mock(() => {}),
  },
}));

const { buildNexusWorkspaceHandler } = await import(
  "../../../../src/main/features/custom-protocols/nexus-workspace"
);
const { clearOutsideGrants, setOutsideGrant } = await import(
  "../../../../src/main/features/fs/outside-grants"
);

const BYTES = Buffer.from("0123456789");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-outside-proto-")));
const root = path.join(tmp, "proj");
const out = path.join(tmp, "out.bin");
fs.mkdirSync(root);
fs.writeFileSync(out, BYTES);
afterEach(() => clearOutsideGrants());
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function manager(meta: Partial<WorkspaceMeta>, fsProvider?: Partial<FsProvider>): WorkspaceManager {
  return {
    list: () => [{ id: "ws", name: "w", pinned: false, tabs: [], ...meta }],
    getFs: async () => fsProvider as FsProvider,
  } as unknown as WorkspaceManager;
}

function outsideUrl(absPath: string): string {
  return `nexus-workspace://ws.outside${absPath.split("/").map(encodeURIComponent).join("/")}`;
}

describe("nexus-workspace:// outside files", () => {
  const local = buildNexusWorkspaceHandler(
    manager({
      rootPath: root,
      location: { kind: "local", rootPath: root },
    } as Partial<WorkspaceMeta>),
  );

  test("a local file is served only while a tab grants it", async () => {
    const ask = () => local(new Request(outsideUrl(out), { headers: { Range: "bytes=2-4" } }));
    expect((await ask()).status).toBe(404);
    setOutsideGrant("ws", "tab", [out], []);
    const resp = await ask();
    expect(resp.status).toBe(206);
    expect(await resp.text()).toBe("234");
    setOutsideGrant("ws", "tab", [], []);
    expect((await ask()).status).toBe(404);
  });

  test("another workspace's grant does not serve it", async () => {
    setOutsideGrant("ws-2", "tab", [out], []);
    const resp = await local(new Request(outsideUrl(out), { headers: { Range: "bytes=0-1" } }));
    expect(resp.status).toBe(404);
  });

  test("an SSH workspace reads a granted path through the agent by its absolute path", async () => {
    const asked: string[] = [];
    const ssh = buildNexusWorkspaceHandler(
      manager(
        {
          rootPath: "/home/u/p",
          location: { kind: "ssh", host: "h", user: "u", remotePath: "/home/u/p" },
        } as Partial<WorkspaceMeta>,
        {
          kind: "ssh",
          readBinary: async () => ({ kind: "missing", reason: "not-found" }),
          readAbsoluteBinary: async (absPath: string) => {
            asked.push(absPath);
            return {
              kind: "ok",
              base64: BYTES.toString("base64"),
              sizeBytes: BYTES.length,
              mtime: "2026-01-01T00:00:00.000Z",
            };
          },
        },
      ),
    );
    expect((await ssh(new Request(outsideUrl("/tmp/shot.png")))).status).toBe(404);
    expect(asked).toEqual([]);
    setOutsideGrant("ws", "tab", ["/tmp/shot.png"], []);
    const resp = await ssh(new Request(outsideUrl("/tmp/shot.png")));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("image/png");
    expect(asked).toEqual(["/tmp/shot.png"]);
  });
});
