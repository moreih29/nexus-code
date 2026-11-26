import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RpcErrorCode } from "../../../../../packages/remote-protocol/src";
import type { FsProvider } from "../../../../../src/main/features/fs/bridge/provider";
import { AgentGate } from "../../../../../src/main/features/remote/agent-gate";
import {
  listFiles,
  type RemoteFiles,
  readFile,
} from "../../../../../src/main/features/remote/files";
import { type FolderSystem, listFolders } from "../../../../../src/main/features/remote/folders";
import { serveWith } from "../../../../../src/main/features/remote/serve";
import { isNetworkOrDevicePath } from "../../../../../src/shared/fs/outside-url";
import { fakeApp } from "../../cli/fake-services";

const PATH_KINDS: { path: string; kind: string; cleaned?: string }[] = JSON.parse(
  fs.readFileSync(
    path.join(import.meta.dir, "../../../../fixtures/windows-path-kinds.json"),
    "utf8",
  ),
);

const TARGETS = [
  String.raw`\\h\s\a.png`,
  "//h/s/a.png",
  String.raw`\\?\UNC\h\s\a`,
  String.raw`\??\UNC\h\s\a`,
  "/??/UNC/h/s/a.png",
  String.raw`\\.\C:\a`,
  String.raw`/x/../\h\s\a.png`,
  String.raw`\\127.0.0.1\qa-none-462\a.png`,
  String.raw`\\qa-nohost-462\s\a.png`,
];
const AUTOMOUNT = ["/net/h/s/a.png", "/Network/s/a.png", "/x/../net/h/a.png"];
const REFUSED = [
  ...new Set([
    ...TARGETS,
    ...AUTOMOUNT,
    ...PATH_KINDS.filter(
      ({ kind, cleaned }) => kind === "unc" || kind === "device" || cleaned !== undefined,
    ).map(({ path }) => path),
  ]),
].filter((p) => p !== "");

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-net-reads-")));
const root = path.join(tmp, "w");
const outsideDir = path.join(tmp, "outside");
const outside = path.join(outsideDir, "a.txt");
fs.mkdirSync(root);
fs.mkdirSync(outsideDir);
fs.writeFileSync(path.join(root, "in.txt"), "inside");
fs.writeFileSync(outside, "outside");
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ROOTS = [root, String.raw`C:\qa\w`, "/qa/w", String.raw`\\nas\share\w`];

function refusedUnder(workspaceRoot: string): string[] {
  return workspaceRoot.startsWith("/") ? REFUSED.filter((p) => p.startsWith("/")) : REFUSED;
}

function content(bytes: Buffer) {
  return {
    kind: "ok" as const,
    base64: bytes.toString("base64"),
    sizeBytes: bytes.length,
    mtime: "",
  };
}

function provider(kind: FsProvider["kind"] = "local") {
  const read = async (absolute: string) => content(await fs.promises.readFile(absolute));
  const calls = {
    stat: mock(async (rel: string) => {
      const s = await fs.promises.readFile(path.join(root, rel)).then(
        (b) => ({ type: "file" as const, size: b.length }),
        () => ({ type: "dir" as const, size: 0 }),
      );
      return { ...s, mtime: "", isSymlink: false };
    }),
    readPreview: mock(async (target: { relPath?: string; absolutePath?: string }) => {
      const bytes = await fs.promises.readFile(
        target.absolutePath ?? path.join(root, target.relPath ?? ""),
      );
      return {
        kind: "content" as const,
        base64: bytes.toString("base64"),
        sizeBytes: bytes.length,
      };
    }),
    readdirNoLinks: mock(async () => []),
    readRange: mock(async (rel: string) => read(path.join(root, rel))),
    readBinary: mock(async (rel: string) => read(path.join(root, rel))),
    readAbsoluteRange: mock(read),
    readAbsoluteBinary: mock(read),
  };
  return { fs: { kind, ...calls } as unknown as FsProvider, calls };
}

const spies: ReturnType<typeof spyOn>[] = [];
let fsCalls: () => number;
beforeEach(() => {
  const p = fs.promises;
  spies.push(
    spyOn(fsPromises, "readdir"),
    spyOn(fsPromises, "realpath"),
    spyOn(fsPromises, "stat"),
    spyOn(p, "realpath"),
    spyOn(p, "stat"),
    spyOn(p, "lstat"),
    spyOn(p, "open"),
    spyOn(p, "readdir"),
    spyOn(p, "access"),
  );
  fsCalls = () => spies.reduce((n, spy) => n + spy.mock.calls.length, 0);
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function agentCalls(calls: ReturnType<typeof provider>["calls"]): number {
  return Object.values(calls).reduce((n, call) => n + call.mock.calls.length, 0);
}

function remoteFiles(
  fsProvider: FsProvider,
  { named = [], folders = [] }: { named?: string[]; folders?: string[] },
): RemoteFiles {
  return {
    fs: async () => fsProvider,
    folders: async () => folders,
    named: async () => named,
    shrink: () => null,
  };
}

describe("a network, device or automount path asked by another device", () => {
  for (const kind of ["local", "ssh"] as const) {
    test(`is refused by files.read and files.list before any file call (${kind})`, async () => {
      const { fs: agent, calls } = provider(kind);
      const asNamed = remoteFiles(agent, { named: REFUSED });
      const asFolder = remoteFiles(agent, { folders: REFUSED });
      for (const workspaceRoot of ROOTS) {
        for (const asked of refusedUnder(workspaceRoot)) {
          const params = { workspaceId: "w", path: asked };
          for (const request of [
            () => readFile(asNamed, workspaceRoot, params),
            () =>
              readFile(asNamed, workspaceRoot, { ...params, as: "bytes", offset: 0, length: 4 }),
            () => readFile(asFolder, workspaceRoot, params),
            () => readFile(asNamed, workspaceRoot, { ...params, anywhere: true }),
            () => listFiles(asFolder, workspaceRoot, params),
            () => listFiles(asNamed, workspaceRoot, { ...params, anywhere: true }),
          ]) {
            await expect(request()).rejects.toMatchObject({ code: RpcErrorCode.Forbidden });
          }
        }
      }
      expect(fsCalls()).toBe(0);
      expect(agentCalls(calls)).toBe(0);
    });
  }

  test("the same spies see a named file, a chat's folder and an anywhere read on this computer", async () => {
    const { fs: agent, calls } = provider();
    const named = await readFile(remoteFiles(agent, { named: [outside] }), root, {
      workspaceId: "w",
      path: outside,
    });
    expect(named).toMatchObject({ kind: "text", text: "outside" });
    expect(calls.readPreview).toHaveBeenCalledTimes(1);
    const folder = await readFile(remoteFiles(agent, { folders: [outsideDir] }), root, {
      workspaceId: "w",
      path: outside,
    });
    expect(folder).toMatchObject({ kind: "text", text: "outside" });
    const anywhere = await readFile(remoteFiles(agent, {}), root, {
      workspaceId: "w",
      path: outside,
      anywhere: true,
    });
    expect(anywhere).toMatchObject({ kind: "text", text: "outside" });
    await listFiles(remoteFiles(agent, { folders: [outsideDir] }), root, {
      workspaceId: "w",
      path: outsideDir,
    });
    expect(spies[3]?.mock.calls.length).toBeGreaterThan(0);
    expect(calls.readdirNoLinks).toHaveBeenCalledTimes(1);
    expect(agentCalls(calls)).toBeGreaterThanOrEqual(4);
  });

  test("a path inside the workspace's folder reads as before, a share's workspace too", async () => {
    const { fs: agent, calls } = provider();
    const files = remoteFiles(agent, {});
    for (const asked of ["in.txt", path.join(root, "in.txt")]) {
      expect(await readFile(files, root, { workspaceId: "w", path: asked })).toMatchObject({
        kind: "text",
        text: "inside",
      });
    }
    const share = String.raw`\\nas\share\w`;
    calls.readPreview.mockImplementation(async () => content(Buffer.from("on the share")) as never);
    for (const asked of [
      "src/a.ts",
      String.raw`\\nas\share\w\src\a.ts`,
      "//nas/share/w/src/a.ts",
    ]) {
      expect(await readFile(files, share, { workspaceId: "w", path: asked })).toMatchObject({
        kind: "text",
        path: String.raw`\\nas\share\w\src\a.ts`,
      });
    }
    expect(calls.readPreview.mock.calls.at(-1)?.[0]).toMatchObject({ relPath: "src/a.ts" });
  });
});

describe("files.read and files.list served to another device", () => {
  function serving(named: string[]) {
    const app = fakeApp();
    const workspace = app.workspaces[0];
    if (!workspace) throw new Error("workspace fixture is missing");
    Object.assign(workspace, { rootPath: root, location: { kind: "local", rootPath: root } });
    app.uiAnswers.set("workspace.folders", { folders: [] });
    app.uiAnswers.set("chat.outsideFiles", { files: named });
    const { fs: agent, calls } = provider();
    const serve = serveWith(() => app.services, {
      agents: new AgentGate({ policy: () => "allow" }),
      controls: () => ({ chat: true, terminal: true }),
      files: { fs: async () => agent, shrink: () => null },
    });
    return { app, serve, calls, workspaceId: workspace.id };
  }
  const from = { kind: "tab" as const, workspaceId: "pw", tabId: "pt" };

  test("refuses what a chat names or what is asked anywhere, before any file call", async () => {
    const { app, serve, calls, workspaceId } = serving(REFUSED);
    for (const asked of refusedUnder(root)) {
      for (const method of ["files.read", "files.list"] as const) {
        for (const params of [
          { workspaceId, path: asked },
          { workspaceId, path: asked, from, anywhere: true as const },
        ]) {
          await expect(serve({ from: "phone", method, params })).rejects.toMatchObject({
            code: RpcErrorCode.Forbidden,
          });
        }
      }
    }
    expect(fsCalls()).toBe(0);
    expect(agentCalls(calls)).toBe(0);
    expect(app.uiCalls.some(({ op }) => op === "consent.ask")).toBe(false);
  });

  test("still reads a file a chat names on this computer", async () => {
    const { serve, calls, workspaceId } = serving([outside]);
    await expect(
      serve({ from: "phone", method: "files.read", params: { workspaceId, path: outside } }),
    ).resolves.toMatchObject({ kind: "text", text: "outside" });
    expect(calls.readPreview).toHaveBeenCalledTimes(1);
  });
});

describe("folders.list asked by another device", () => {
  const system = (platform: NodeJS.Platform): FolderSystem => ({ platform, home: () => tmp });

  test.if(process.platform === "win32")(
    "refuses a share or device path, also one that cleans into one",
    async () => {
      for (const asked of REFUSED.filter((p) => isNetworkOrDevicePath(p))) {
        await expect(listFolders({ path: asked }, system("win32"))).rejects.toMatchObject({
          code: RpcErrorCode.InvalidParams,
        });
      }
      expect(fsCalls()).toBe(0);
      expect((await listFolders({ path: tmp }, system("win32"))).entries).toEqual([
        { name: "outside" },
        { name: "w" },
      ]);
      expect(spies[0]?.mock.calls.length).toBeGreaterThan(0);
    },
  );

  test.if(process.platform !== "win32")("refuses an automount path", async () => {
    for (const asked of [...AUTOMOUNT, "/System/Volumes/Data/net/h"]) {
      await expect(listFolders({ path: asked }, system("darwin"))).rejects.toMatchObject({
        code: RpcErrorCode.InvalidParams,
      });
    }
    expect((await listFolders({ path: tmp }, system("darwin"))).entries).toEqual([
      { name: "outside" },
      { name: "w" },
    ]);
  });
});
