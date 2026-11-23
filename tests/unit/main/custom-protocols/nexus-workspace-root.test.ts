import { afterAll, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-root-")));
const root = path.join(tmp, "proj");
fs.mkdirSync(path.join(root, "sub"), { recursive: true });
fs.writeFileSync(path.join(root, "sub", "a.txt"), "inside");
fs.writeFileSync(path.join(tmp, "secret.txt"), "outside");
fs.mkdirSync(path.join(tmp, "proj-other"));
fs.writeFileSync(path.join(tmp, "proj-other", "b.txt"), "sibling");
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function handler(rootPath: string) {
  return buildNexusWorkspaceHandler({
    list: () => [
      {
        id: "ws",
        name: "w",
        pinned: false,
        tabs: [],
        rootPath,
        location: { kind: "local", rootPath },
      } as unknown as WorkspaceMeta,
    ],
  } as unknown as WorkspaceManager);
}

function cases(name: string, rootPath: string) {
  describe(`nexus-workspace:// local root (${name})`, () => {
    const serve = handler(rootPath);

    test("serves a file inside the root", async () => {
      const res = await serve(new Request("nexus-workspace://ws/sub/a.txt"));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("inside");
    });

    test("answers 404 for a path that climbs out of the root", async () => {
      const up = await serve(new Request("nexus-workspace://ws/%2E%2E%2Fsecret.txt"));
      expect(up.status).toBe(404);
      const sibling = await serve(new Request("nexus-workspace://ws/%2E%2E%2Fproj-other%2Fb.txt"));
      expect(sibling.status).toBe(404);
    });
  });
}

cases("native separators", root);
cases("trailing separator", root + path.sep);
if (process.platform === "win32") {
  cases("forward slashes", root.replaceAll("\\", "/"));
}
