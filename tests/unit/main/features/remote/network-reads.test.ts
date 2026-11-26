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
  networkRootOf,
  outsideFileSource,
  type RemoteFiles,
  readFile,
} from "../../../../../src/main/features/remote/files";
import { type FolderSystem, listFolders } from "../../../../../src/main/features/remote/folders";
import { serveWith } from "../../../../../src/main/features/remote/serve";
import { consentNamesNetworkPath } from "../../../../../src/shared/cli/consent-copy";
import type { CliChange } from "../../../../../src/shared/cli/ui";
import { isDevicePath, isNetworkOrDevicePath } from "../../../../../src/shared/fs/outside-url";
import { fakeApp } from "../../cli/fake-services";

const WINDOWS = process.platform === "win32";

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
const DEVICES = REFUSED.filter((p) => isDevicePath(p) || isDevicePath(path.posix.normalize(p)));
const NETWORK_ANYWHERE = WINDOWS
  ? [String.raw`\\127.0.0.1\qa-none-462\a.txt`, "//h/s/a.txt", String.raw`\\qa-nohost-462\s\a`]
  : ["/net/h/s/a.txt", "/Network/s/a.txt", "/x/../net/h/a.txt"];

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

function preview(text: string) {
  const bytes = Buffer.from(text);
  return { kind: "content" as const, base64: bytes.toString("base64"), sizeBytes: bytes.length };
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
      return preview(bytes.toString());
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
let realpaths: () => string[];
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
  realpaths = () =>
    [spies[1], spies[3]].flatMap((spy) => spy?.mock.calls.map((call) => String(call[0])) ?? []);
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function resolveAs(resolve: (p: string) => string) {
  spies[3]?.mockImplementation((async (p: string) => resolve(p)) as never);
}

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

describe("a network, device or automount path a chat names, or asked anywhere unapproved", () => {
  for (const kind of ["local", "ssh"] as const) {
    test(`is refused by files.read and files.list before any file call (${kind})`, async () => {
      const { fs: agent, calls } = provider(kind);
      const asNamed = remoteFiles(agent, { named: REFUSED });
      for (const workspaceRoot of ROOTS) {
        for (const asked of refusedUnder(workspaceRoot)) {
          const params = { workspaceId: "w", path: asked };
          for (const request of [
            () => readFile(asNamed, workspaceRoot, params),
            () =>
              readFile(asNamed, workspaceRoot, { ...params, as: "bytes", offset: 0, length: 4 }),
            () => readFile(asNamed, workspaceRoot, { ...params, anywhere: true }),
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

  test("a named file on an SSH host is not resolved on this computer", async () => {
    const { fs: agent, calls } = provider("ssh");
    await readFile(remoteFiles(agent, { named: [outside] }), root, {
      workspaceId: "w",
      path: outside,
    });
    expect(realpaths()).toEqual([]);
    expect(calls.readPreview.mock.calls[0]?.[0]).not.toHaveProperty("expectedRealPath");
  });

  test("an older agent's named read is resolved before and after it", async () => {
    const { fs: agent, calls } = provider();
    const older = { ...agent, readPreview: undefined } as unknown as FsProvider;
    const got = await readFile(remoteFiles(older, { named: [outside] }), root, {
      workspaceId: "w",
      path: outside,
    });
    expect(got).toMatchObject({ kind: "text", text: "outside" });
    expect(calls.readAbsoluteRange).toHaveBeenCalledTimes(1);
    expect(realpaths().filter((p) => p === outside)).toHaveLength(2);
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
    calls.readPreview.mockImplementation(async () => preview("on the share"));
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

describe("a share folder the host gave a chat", () => {
  const FOLDERS = [
    String.raw`\\nas\share\w`,
    "//NAS/Share/Data/",
    String.raw`\\?\UNC\nas\share\dev`,
    String.raw`\\nas\share\Ä`,
  ];
  const WINDOWS_ROOTS = [String.raw`C:\qa\w`, String.raw`\\nas\share\root`];
  const INSIDE: [string, string][] = [
    [String.raw`\\nas\share\w\a.txt`, String.raw`\\nas\share\w\a.txt`],
    ["//nas/share/w/sub/a.txt", String.raw`\\nas\share\w\sub\a.txt`],
    [String.raw`\\NAS\SHARE\W\a.txt`, String.raw`\\NAS\SHARE\W\a.txt`],
    [String.raw`\\nas\share\w\x\..\a.txt`, String.raw`\\nas\share\w\a.txt`],
    [String.raw`\\nas\share\data\a.txt`, String.raw`\\nas\share\data\a.txt`],
  ];
  const OUTSIDE = [
    String.raw`\\nas\share\other\a.txt`,
    String.raw`\\nas\share\w2\a.txt`,
    String.raw`\\nas\share\w\..\w2\a.txt`,
    String.raw`\\nas\share\w\..\..\other\a.txt`,
    String.raw`\\nas2\share\w\a.txt`,
    String.raw`\\nas\share2\w\a.txt`,
    String.raw`\\nas\share\ä\a.txt`,
    String.raw`\\nas\share`,
    String.raw`\\?\UNC\nas\share\w\a.txt`,
    String.raw`\\.\UNC\nas\share\w\a.txt`,
    String.raw`\??\UNC\nas\share\w\a.txt`,
    "/??/UNC/nas/share/w/a.txt",
    String.raw`\\?\UNC\nas\share\dev\a.txt`,
  ];

  test("gives files inside it, compared after cleaning, ASCII case folded", async () => {
    resolveAs((p) => p.toLowerCase());
    const { fs: agent, calls } = provider();
    calls.readPreview.mockImplementation(async () => preview("on the share"));
    const files = remoteFiles(agent, { folders: FOLDERS });
    for (const workspaceRoot of WINDOWS_ROOTS) {
      for (const [asked, absolute] of INSIDE) {
        expect(
          await readFile(files, workspaceRoot, { workspaceId: "w", path: asked }),
        ).toMatchObject({ kind: "text", text: "on the share", path: absolute });
        expect(calls.readPreview.mock.calls.at(-1)?.[0]).toMatchObject({
          absolutePath: absolute,
          expectedRealPath: absolute.toLowerCase(),
        });
      }
      if (WINDOWS) {
        await listFiles(files, workspaceRoot, {
          workspaceId: "w",
          path: String.raw`\\nas\share\w`,
        });
      }
    }
    expect(calls.readdirNoLinks).toHaveBeenCalledTimes(WINDOWS ? WINDOWS_ROOTS.length : 0);
    expect(realpaths().some((p) => /dev|Ä/.test(p))).toBe(false);
  });

  for (const kind of ["local", "ssh"] as const) {
    test(`refuses a path beside it or written as a device, before any file call (${kind})`, async () => {
      const { fs: agent, calls } = provider(kind);
      const files = remoteFiles(agent, { folders: FOLDERS });
      for (const workspaceRoot of WINDOWS_ROOTS) {
        for (const asked of OUTSIDE) {
          const params = { workspaceId: "w", path: asked };
          await expect(readFile(files, workspaceRoot, params)).rejects.toMatchObject({
            code: RpcErrorCode.Forbidden,
          });
          await expect(listFiles(files, workspaceRoot, params)).rejects.toMatchObject({
            code: RpcErrorCode.Forbidden,
          });
        }
      }
      expect(fsCalls()).toBe(0);
      expect(agentCalls(calls)).toBe(0);
    });
  }

  const AUTOMOUNT_FOLDERS = ["/net/h/x", "/Network/Data/", "/x/../net/h3/y", "//NAS/Share/Data"];
  const AUTOMOUNT_INSIDE: [string, string][] = [
    ["/net/h/x/a.txt", "/net/h/x/a.txt"],
    ["/net/h/x/sub/a.txt", "/net/h/x/sub/a.txt"],
    ["/net/h/x/y/../a.txt", "/net/h/x/a.txt"],
    ["/x/../net/h/x/a.txt", "/net/h/x/a.txt"],
    ["//net/h/x/./a.txt", "/net/h/x/a.txt"],
    ["/Network/Data/a.txt", "/Network/Data/a.txt"],
    ["/net/h3/y/a.txt", "/net/h3/y/a.txt"],
  ];
  const AUTOMOUNT_OUTSIDE = [
    "/net/h/x2/a.txt",
    "/net/h/x/../x2/a.txt",
    "/net/h/x/../../h2/x/a.txt",
    "/net/h/a.txt",
    "/net/h",
    "/net/h2/x/a.txt",
    "/net/h/X/a.txt",
    "/NET/h/x/a.txt",
    "/Network/Data2/a.txt",
    "/Network/s/a.txt",
    "/System/Volumes/Data/net/h/x/a.txt",
    "//NAS/Share/Data/a.txt",
    "/??/UNC/h/x",
    "/??/UNC/net/h/x/a.txt",
  ];

  test("an automount folder gives files inside it, compared after cleaning, in a POSIX workspace", async () => {
    resolveAs((p) => p);
    const { fs: agent, calls } = provider();
    calls.readPreview.mockImplementation(async () => preview("mounted"));
    const files = remoteFiles(agent, { folders: AUTOMOUNT_FOLDERS });
    for (const [asked, absolute] of AUTOMOUNT_INSIDE) {
      expect(await readFile(files, "/qa/w", { workspaceId: "w", path: asked })).toMatchObject({
        kind: "text",
        text: "mounted",
        path: absolute,
      });
      expect(calls.readPreview.mock.calls.at(-1)?.[0]).toMatchObject({
        absolutePath: absolute,
        expectedRealPath: absolute,
      });
    }
    await listFiles(files, "/qa/w", { workspaceId: "w", path: "/net/h/x" });
    expect(calls.readdirNoLinks).toHaveBeenCalledTimes(1);
  });

  for (const kind of ["local", "ssh"] as const) {
    test(`an automount folder refuses a path beside it, before any file call (${kind})`, async () => {
      const { fs: agent, calls } = provider(kind);
      const files = remoteFiles(agent, { folders: AUTOMOUNT_FOLDERS });
      for (const asked of AUTOMOUNT_OUTSIDE) {
        const params = { workspaceId: "w", path: asked };
        await expect(readFile(files, "/qa/w", params)).rejects.toMatchObject({
          code: RpcErrorCode.Forbidden,
        });
        await expect(listFiles(files, "/qa/w", params)).rejects.toMatchObject({
          code: RpcErrorCode.Forbidden,
        });
      }
      expect(fsCalls()).toBe(0);
      expect(agentCalls(calls)).toBe(0);
    });
  }

  test("a file in a folder on this computer resolves no network or automount folder", async () => {
    const { fs: agent } = provider();
    const network = [String.raw`\\h\s\x`, "//h2/s/x", "/net/h/x", String.raw`\\?\UNC\h\s`];
    const files = remoteFiles(agent, { folders: [outsideDir, ...network] });
    expect(await readFile(files, root, { workspaceId: "w", path: outside })).toMatchObject({
      text: "outside",
    });
    await listFiles(files, root, { workspaceId: "w", path: outsideDir });
    expect(realpaths()).toContain(outsideDir);
    expect(realpaths().filter((p) => network.includes(p))).toEqual([]);
  });
});

describe("files.read and files.list served to another device", () => {
  function serving({
    named = [],
    folders = [],
    answer = "once",
    policy = "ask",
  }: {
    named?: string[];
    folders?: string[];
    answer?: "once" | "session" | "deny" | (() => "once" | "session" | "deny");
    policy?: "ask" | "allow";
  }) {
    const app = fakeApp();
    const workspace = app.workspaces[0];
    if (!workspace) throw new Error("workspace fixture is missing");
    Object.assign(workspace, { rootPath: root, location: { kind: "local", rootPath: root } });
    app.uiAnswers.set("workspace.folders", { folders });
    app.uiAnswers.set("chat.outsideFiles", { files: named });
    const { fs: agent, calls } = provider();
    const asks: { change: CliChange; fsCalls: number; agentCalls: number }[] = [];
    app.uiAnswers.set("consent.ask", (args: unknown) => {
      asks.push({
        change: (args as { change: CliChange }).change,
        fsCalls: fsCalls(),
        agentCalls: agentCalls(calls),
      });
      return { answer: typeof answer === "function" ? answer() : answer };
    });
    const serve = serveWith(() => app.services, {
      agents: new AgentGate({ policy: () => policy }),
      controls: () => ({ chat: true, terminal: true }),
      files: { fs: async () => agent, shrink: () => null },
    });
    return { serve, calls, asks, workspaceId: workspace.id };
  }
  const from = { kind: "tab" as const, workspaceId: "pw", tabId: "pt" };
  const methods = ["files.read", "files.list"] as const;

  test("refuses what a chat names, and a device path asked anywhere, before asking", async () => {
    const { serve, calls, asks, workspaceId } = serving({ named: REFUSED });
    for (const asked of refusedUnder(root)) {
      for (const method of methods) {
        await expect(
          serve({ from: "phone", method, params: { workspaceId, path: asked } }),
        ).rejects.toMatchObject({ code: RpcErrorCode.Forbidden });
      }
    }
    for (const asked of DEVICES) {
      for (const method of methods) {
        await expect(
          serve({
            from: "phone",
            method,
            params: { workspaceId, path: asked, from, anywhere: true },
          }),
        ).rejects.toMatchObject({ code: RpcErrorCode.Forbidden });
      }
    }
    expect(asks).toEqual([]);
    expect(fsCalls()).toBe(0);
    expect(agentCalls(calls)).toBe(0);
  });

  test("asks before it touches a network path anywhere, and touches nothing when told no", async () => {
    const { serve, calls, asks, workspaceId } = serving({ answer: "deny" });
    for (const asked of NETWORK_ANYWHERE) {
      for (const method of methods) {
        await expect(
          serve({
            from: "phone",
            method,
            params: { workspaceId, path: asked, from, anywhere: true },
          }),
        ).rejects.toMatchObject({
          code: RpcErrorCode.Forbidden,
          message: "the user there did not allow it",
        });
      }
    }
    expect(asks).toHaveLength(NETWORK_ANYWHERE.length * methods.length);
    for (const { change, fsCalls: before, agentCalls: agents } of asks) {
      expect([change.kind, before, agents]).toEqual([
        expect.stringMatching(/^fileRead(Tree)?$/),
        0,
        0,
      ]);
      expect(consentNamesNetworkPath(change)).toBe(true);
    }
    expect(asks.map(({ change }) => change.kind)).toContain("fileReadTree");
    expect(fsCalls()).toBe(0);
    expect(agentCalls(calls)).toBe(0);
  });

  test("reads and lists a network path anywhere once the user allows it", async () => {
    resolveAs((p) => p);
    spies[2]?.mockImplementation((async () => ({ isDirectory: () => true })) as never);
    for (const asked of NETWORK_ANYWHERE) {
      const { serve, calls, asks, workspaceId } = serving({});
      calls.readPreview.mockImplementation(async () => preview("on the network"));
      const absolute = WINDOWS ? path.win32.normalize(asked) : path.posix.normalize(asked);
      const start = fsCalls();
      await expect(
        serve({
          from: "phone",
          method: "files.read",
          params: { workspaceId, path: asked, from, anywhere: true },
        }),
      ).resolves.toMatchObject({ kind: "text", text: "on the network" });
      expect(calls.readPreview.mock.calls[0]?.[0]).toMatchObject({
        absolutePath: absolute,
        expectedRealPath: absolute,
      });
      const afterRead = fsCalls();
      await expect(
        serve({
          from: "phone",
          method: "files.list",
          params: { workspaceId, path: asked, from, anywhere: true },
        }),
      ).resolves.toMatchObject({ path: absolute, entries: [] });
      expect(asks.map(({ fsCalls: before }) => before)).toEqual([start, afterRead]);
      expect(afterRead).toBeGreaterThan(start);
      expect(asks[0]).toMatchObject({ change: { kind: "fileRead", detail: absolute } });
      expect(realpaths()).toContain(absolute);
    }
  });

  test("refuses an allowed network path that resolves off the network", async () => {
    resolveAs(() => outside);
    const { serve, calls, workspaceId } = serving({});
    await expect(
      serve({
        from: "phone",
        method: "files.read",
        params: { workspaceId, path: NETWORK_ANYWHERE[0] ?? "", from, anywhere: true },
      }),
    ).rejects.toMatchObject({ code: RpcErrorCode.Forbidden });
    expect(agentCalls(calls)).toBe(0);
  });

  const SAME_SHARE = WINDOWS
    ? {
        asked: String.raw`\\h\s\a.txt`,
        same: [String.raw`\\H\S\sub\b.txt`, String.raw`\\h\s\a.txt`],
        other: [String.raw`\\other\s\a.txt`, String.raw`\\h\s2\a.txt`, String.raw`\\h\t\a.txt`],
      }
    : {
        asked: "/net/h/a.txt",
        same: ["/net/h/sub/b.txt", "/System/Volumes/Data/net/h/a.txt", "/net/H/a.txt"],
        other: ["/net/other/a.txt", "/Network/h/a.txt", "/net/h2/a.txt"],
      };

  test("refuses an allowed network path that resolves to another share or host", async () => {
    for (const resolved of SAME_SHARE.other) {
      resolveAs(() => resolved);
      const { serve, calls, asks, workspaceId } = serving({});
      await expect(
        serve({
          from: "phone",
          method: "files.read",
          params: { workspaceId, path: SAME_SHARE.asked, from, anywhere: true },
        }),
      ).rejects.toMatchObject({
        code: RpcErrorCode.Forbidden,
        message: `${SAME_SHARE.asked} leads off the network path that was allowed`,
      });
      expect(asks).toHaveLength(1);
      expect(agentCalls(calls)).toBe(0);
    }
    for (const resolved of SAME_SHARE.same) {
      resolveAs(() => resolved);
      const { serve, calls, workspaceId } = serving({});
      calls.readPreview.mockImplementation(async () => preview("same share"));
      await expect(
        serve({
          from: "phone",
          method: "files.read",
          params: { workspaceId, path: SAME_SHARE.asked, from, anywhere: true },
        }),
      ).resolves.toMatchObject({ text: "same share" });
      expect(calls.readPreview.mock.calls[0]?.[0]).toMatchObject({ expectedRealPath: resolved });
    }
  });

  test("the share or automount host a path is on", () => {
    const table: [string, string | null][] = [
      [String.raw`\\h\s\a.txt`, String.raw`\\h\s`],
      ["//H/S/sub/a.txt", String.raw`\\h\s`],
      [String.raw`\\h\s`, String.raw`\\h\s`],
      [String.raw`\\h\s\..\t\a`, String.raw`\\h\s`],
      [String.raw`\\h`, null],
      [String.raw`C:\h\s`, null],
      ["/net/h/a.txt", "/net/h"],
      ["/net/H/x/../a", "/net/h"],
      ["/System/Volumes/Data/net/h/a", "/net/h"],
      ["/Network/Servers/h/s/a", "/network/servers/h"],
      ["/Network/Data/a", "/network/data"],
      ["/net", null],
      ["/Network/Servers", null],
      ["/x/../net/h/a", "/net/h"],
      ["/Users/me/net/h", null],
    ];
    expect(table.map(([p]) => [p, networkRootOf(p)])).toEqual(table);
  });

  test("a path on this computer is still resolved before it asks, through the same spies", async () => {
    const { serve, asks, workspaceId } = serving({});
    await serve({
      from: "phone",
      method: "files.list",
      params: { workspaceId, path: outsideDir, from, anywhere: true },
    });
    expect(asks[0]?.fsCalls).toBeGreaterThan(0);
    expect(spies[2]?.mock.calls.length).toBeGreaterThan(0);
    expect(consentNamesNetworkPath(asks[0]?.change ?? { kind: "fileRead" })).toBe(false);
  });

  test("under the allow policy, a network path anywhere is still asked about, with nothing touched first", async () => {
    const { serve, calls, asks, workspaceId } = serving({ policy: "allow", answer: "deny" });
    for (const asked of NETWORK_ANYWHERE) {
      for (const method of methods) {
        await expect(
          serve({
            from: "phone",
            method,
            params: { workspaceId, path: asked, from, anywhere: true },
          }),
        ).rejects.toMatchObject({
          code: RpcErrorCode.Forbidden,
          message: "the user there did not allow it",
        });
      }
    }
    expect(asks).toHaveLength(NETWORK_ANYWHERE.length * methods.length);
    expect(asks.map(({ fsCalls: before, agentCalls: agents }) => [before, agents])).toEqual(
      asks.map(() => [0, 0]),
    );
    expect(fsCalls()).toBe(0);
    expect(agentCalls(calls)).toBe(0);
  });

  test("under the allow policy, a network read allowed once goes on, and the same read again is not asked", async () => {
    resolveAs((p) => p);
    for (const asked of NETWORK_ANYWHERE) {
      const { serve, calls, asks, workspaceId } = serving({ policy: "allow" });
      calls.readPreview.mockImplementation(async () => preview("on the network"));
      const start = fsCalls();
      const request = {
        from: "phone",
        method: "files.read" as const,
        params: { workspaceId, path: asked, from, anywhere: true as const },
      };
      await expect(serve(request)).resolves.toMatchObject({ text: "on the network" });
      expect(asks.map(({ fsCalls: before }) => before)).toEqual([start]);
      await expect(serve(request)).resolves.toMatchObject({ text: "on the network" });
      expect(asks).toHaveLength(1);
      expect(calls.readPreview).toHaveBeenCalledTimes(2);
    }
  });

  test("under the allow policy, allowed until restart, other network reads go on without asking", async () => {
    resolveAs((p) => p);
    spies[2]?.mockImplementation((async () => ({ isDirectory: () => true })) as never);
    const { serve, calls, asks, workspaceId } = serving({ policy: "allow", answer: "session" });
    calls.readPreview.mockImplementation(async () => preview("on the network"));
    for (const asked of NETWORK_ANYWHERE) {
      for (const method of methods) {
        await serve({
          from: "phone",
          method,
          params: { workspaceId, path: asked, from, anywhere: true },
        });
      }
    }
    expect(asks).toHaveLength(1);
  });

  test("under the allow policy, a path on this computer is read and listed without asking, as before", async () => {
    const { serve, asks, workspaceId } = serving({ policy: "allow", answer: "deny" });
    await expect(
      serve({
        from: "phone",
        method: "files.read",
        params: { workspaceId, path: outside, from, anywhere: true },
      }),
    ).resolves.toMatchObject({ kind: "text", text: "outside" });
    await expect(
      serve({
        from: "phone",
        method: "files.list",
        params: { workspaceId, path: outsideDir, from, anywhere: true },
      }),
    ).resolves.toMatchObject({ path: outsideDir });
    expect(asks).toEqual([]);
  });

  test("still reads a file a chat names on this computer", async () => {
    const { serve, calls, workspaceId } = serving({ named: [outside] });
    await expect(
      serve({ from: "phone", method: "files.read", params: { workspaceId, path: outside } }),
    ).resolves.toMatchObject({ kind: "text", text: "outside" });
    expect(calls.readPreview).toHaveBeenCalledTimes(1);
  });
});

describe("a write target another device names", () => {
  const transferId = "8f14e45f-ceea-467f-a5b4-0e5a3a5f6c2d";
  const SHARE = WINDOWS ? String.raw`\\nas\share\w` : "/net/h/x";
  const INSIDE = WINDOWS ? String.raw`\\NAS\share\w\in` : "/net/h/x/in";
  const BESIDE = WINDOWS
    ? [
        String.raw`\\nas\share\w2`,
        String.raw`\\h\s`,
        "//h/s/dir",
        String.raw`\\?\UNC\nas\share\w\in`,
      ]
    : ["/net/h/x2", "/net/h", "/Network/s", "/??/UNC/h/s"];

  function serving(folders: string[], policy: "ask" | "allow" = "ask") {
    const app = fakeApp();
    const workspace = app.workspaces[0];
    if (!workspace) throw new Error("workspace fixture is missing");
    Object.assign(workspace, { rootPath: root, location: { kind: "local", rootPath: root } });
    app.uiAnswers.set("workspace.folders", { folders });
    let asked = 0;
    app.uiAnswers.set("consent.ask", () => {
      asked++;
      return { answer: "once" };
    });
    const serve = serveWith(() => app.services, {
      agents: new AgentGate({ policy: () => policy }),
      controls: () => ({ chat: true, terminal: true }),
      files: { fs: async () => provider().fs, shrink: () => null },
    });
    return { serve, workspaceId: workspace.id, asks: () => asked };
  }
  const from = { kind: "tab" as const, workspaceId: "pw", tabId: "pt" };

  test("is refused before any file call or question when it is a network path outside a folder the host gave", async () => {
    const { serve, workspaceId, asks } = serving([SHARE]);
    for (const target of BESIDE) {
      await expect(
        serve({
          from: "phone",
          method: "files.list",
          params: {
            workspaceId,
            path: target,
            from,
            anywhere: true,
            writeTarget: true,
            transferId,
          },
        }),
      ).rejects.toMatchObject({ code: RpcErrorCode.Forbidden });
      await expect(
        serve({
          from: "phone",
          method: "files.write.begin",
          params: {
            workspaceId,
            path: `${target}/a.txt`,
            size: 0,
            from,
            anywhere: true,
            transferId,
          },
        }),
      ).rejects.toMatchObject({ code: RpcErrorCode.Forbidden });
    }
    expect(asks()).toBe(0);
    expect(fsCalls()).toBe(0);
  });

  test("inside a folder the host gave, is resolved and asked about as before", async () => {
    resolveAs((p) => p);
    spies[2]?.mockImplementation((async () => ({ isDirectory: () => true })) as never);
    const { serve, workspaceId, asks } = serving([SHARE]);
    await expect(
      serve({
        from: "phone",
        method: "files.list",
        params: { workspaceId, path: INSIDE, from, anywhere: true, writeTarget: true, transferId },
      }),
    ).resolves.toMatchObject({ entries: [] });
    expect(realpaths().length).toBeGreaterThan(0);
    expect(asks()).toBe(1);
  });

  test("under the allow policy, inside a folder the host gave, is still asked about; on this computer it is not", async () => {
    resolveAs((p) => p);
    spies[2]?.mockImplementation((async () => ({ isDirectory: () => true })) as never);
    const { serve, workspaceId, asks } = serving([SHARE], "allow");
    const target = (path: string) => ({
      from: "phone",
      method: "files.list" as const,
      params: { workspaceId, path, from, anywhere: true as const, writeTarget: true, transferId },
    });
    await expect(serve(target(INSIDE))).resolves.toMatchObject({ entries: [] });
    expect(asks()).toBe(1);
    await expect(serve(target(outsideDir))).resolves.toMatchObject({ entries: [] });
    expect(asks()).toBe(1);
  });
});

describe("folders.list asked by another device", () => {
  const system = (platform: NodeJS.Platform): FolderSystem => ({ platform, home: () => tmp });

  test.if(WINDOWS)("refuses a share or device path, also one that cleans into one", async () => {
    for (const asked of REFUSED.filter((p) => isNetworkOrDevicePath(p))) {
      await expect(listFolders({ path: asked }, system("win32"))).rejects.toMatchObject({
        code: RpcErrorCode.InvalidParams,
      });
    }
    expect(fsCalls()).toBe(0);
    await expect(
      listFolders({ path: String.raw`/x/../\h\s\a.png` }, system("win32")),
    ).rejects.toMatchObject({
      code: RpcErrorCode.NotFound,
      message: expect.stringMatching(/^no folder [A-Za-z]:\\h\\s\\a\.png$/),
    });
    const touched = spies.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.filter((p) => isNetworkOrDevicePath(p) || isDevicePath(p))).toEqual([]);
    expect((await listFolders({ path: tmp }, system("win32"))).entries).toEqual([
      { name: "outside" },
      { name: "w" },
    ]);
    expect(spies[0]?.mock.calls.length).toBeGreaterThan(0);
  });

  test.if(!WINDOWS)("refuses an automount path", async () => {
    for (const asked of [...AUTOMOUNT, "/System/Volumes/Data/net/h"]) {
      await expect(listFolders({ path: asked }, system("darwin"))).rejects.toMatchObject({
        code: RpcErrorCode.InvalidParams,
      });
    }
    expect(fsCalls()).toBe(0);
    expect((await listFolders({ path: tmp }, system("darwin"))).entries).toEqual([
      { name: "outside" },
      { name: "w" },
    ]);
  });
});

describe.if(!WINDOWS)("a link on the way to a file another device reads", () => {
  const linkDir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "nexus-net-links-")),
  );
  afterAll(() => fs.rmSync(linkDir, { recursive: true, force: true }));
  const linkedFile = path.join(linkDir, "file.txt");
  const linkedFolder = path.join(linkDir, "share");
  const plainFolder = path.join(linkDir, "plain");
  fs.mkdirSync(plainFolder, { recursive: true });
  fs.symlinkSync(outside, linkedFile);
  fs.symlinkSync(outsideDir, linkedFolder);

  function linksToAutomount() {
    return spyOn(fs.promises, "readlink").mockImplementation((async (p: string) =>
      p === linkedFile ? "/net/qa-s3/a.txt" : p === linkedFolder ? "/Network/qa-s3" : "") as never);
  }

  test("is refused when it leads to an automount path, before the file is resolved or read", async () => {
    const readlink = linksToAutomount();
    try {
      const { fs: agent, calls } = provider();
      for (const [files, asked] of [
        [remoteFiles(agent, { named: [linkedFile] }), linkedFile],
        [remoteFiles(agent, { folders: [linkDir] }), linkedFile],
        [
          remoteFiles(agent, { named: [path.join(linkedFolder, "a.txt")] }),
          path.join(linkedFolder, "a.txt"),
        ],
      ] as const) {
        await expect(
          readFile(files, root, { workspaceId: "w", path: asked }),
        ).rejects.toMatchObject({ code: RpcErrorCode.Forbidden });
      }
      await expect(outsideFileSource(linkedFile)).rejects.toMatchObject({
        code: RpcErrorCode.Forbidden,
      });
      expect(realpaths()).toEqual([]);
      expect(agentCalls(calls)).toBe(0);
    } finally {
      readlink.mockRestore();
    }
  });

  test("reads as before when the link stays on this computer", async () => {
    const { fs: agent } = provider();
    expect(
      await readFile(remoteFiles(agent, { named: [linkedFile] }), root, {
        workspaceId: "w",
        path: linkedFile,
      }),
    ).toMatchObject({ kind: "text", text: "outside" });
  });

  test("folders.list skips a linked folder that leads to an automount path and refuses listing it", async () => {
    const system: FolderSystem = { platform: "darwin", home: () => tmp };
    expect((await listFolders({ path: linkDir }, system)).entries).toEqual([
      { name: "plain" },
      { name: "share" },
    ]);
    const readlink = linksToAutomount();
    try {
      expect((await listFolders({ path: linkDir }, system)).entries).toEqual([{ name: "plain" }]);
      await expect(listFolders({ path: linkedFolder }, system)).rejects.toMatchObject({
        code: RpcErrorCode.InvalidParams,
      });
      expect(realpaths()).toEqual([]);
    } finally {
      readlink.mockRestore();
    }
  });
});
