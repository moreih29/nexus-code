import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RpcErrorCode } from "../../../../../packages/remote-protocol/src";
import type { FsProvider } from "../../../../../src/main/features/fs/bridge/provider";
import { FileGrants } from "../../../../../src/main/features/remote/file-grants";
import { serveWith } from "../../../../../src/main/features/remote/serve";
import { sourcesChanged } from "../../../../../src/main/features/remote/serving/file-links";
import { cleanLinkHref } from "../../../../../src/shared/chat/link-text";
import { networkLinkPath } from "../../../../../src/shared/fs/outside-url";
import { fakeApp } from "../../cli/fake-services";

const NETWORK_LINK =
  process.platform === "win32" ? String.raw`\\qa-host\share\a.png` : "/net/qa-host/a.png";

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-grants-")));
const root = path.join(tmp, "w");
const outside = path.join(tmp, "out");
fs.mkdirSync(root);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(root, "in.txt"), "inside");
fs.writeFileSync(path.join(outside, "a.txt"), "outside a");
fs.writeFileSync(path.join(outside, "standing.txt"), "standing");
fs.writeFileSync(path.join(outside, "doc.md"), "Read [b](b.txt) next.");
fs.writeFileSync(path.join(outside, "b.txt"), "child b");
fs.mkdirSync(path.join(outside, "dir"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function ok(bytes: Buffer) {
  return {
    kind: "ok" as const,
    base64: bytes.toString("base64"),
    sizeBytes: bytes.length,
    mtime: "",
  };
}

function provider(workspaceRoot: string): FsProvider {
  const range = async (absolute: string, offset: number, length: number) => {
    const bytes = await fs.promises.readFile(absolute).catch(() => null);
    if (!bytes) return { kind: "missing" as const, reason: "not-found" as const };
    const read = ok(bytes.subarray(offset, offset + length));
    return { ...read, sizeBytes: bytes.length };
  };
  return {
    kind: "local",
    stat: async (rel: string) => {
      const at = path.join(workspaceRoot, rel);
      const s = await (rel ? fs.promises.lstat(at) : fs.promises.stat(at));
      return {
        type: s.isDirectory() ? "dir" : s.isFile() ? "file" : "symlink",
        size: s.size,
        mtime: "",
        isSymlink: s.isSymbolicLink(),
      };
    },
    readRange: (rel: string, offset: number, length: number) =>
      range(path.join(workspaceRoot, rel), offset, length),
    readAbsoluteRange: range,
    readdirNoLinks: async ({ relPath = "" }: { relPath?: string }) =>
      fs.readdirSync(path.join(workspaceRoot, relPath)).map((name) => ({ name, type: "file" })),
    readPreview: async (target: {
      relPath?: string;
      absolutePath?: string;
      expectedRealPath?: string;
    }) => {
      const file = target.absolutePath ?? path.join(workspaceRoot, target.relPath ?? "");
      if (target.expectedRealPath && fs.realpathSync(file) !== target.expectedRealPath) {
        throw new Error("moved");
      }
      const bytes = fs.readFileSync(file);
      return { kind: "content", base64: bytes.toString("base64"), sizeBytes: bytes.length };
    },
  } as unknown as FsProvider;
}

type Candidates = (links: { href: string; source: { kind: string } }[]) => (string[] | null)[];

function serving({
  rootPath = root,
  standing = [path.join(outside, "standing.txt"), path.join(outside, "doc.md")],
  mentioned = [] as string[],
  candidates = ((links) => links.map((l) => [l.href])) as Candidates,
  present = (sources: unknown[]) => sources.map(() => true),
  legacy = true,
}: {
  rootPath?: string;
  standing?: string[];
  mentioned?: string[];
  candidates?: Candidates;
  present?: (sources: unknown[]) => boolean[];
  legacy?: boolean;
} = {}) {
  const app = fakeApp();
  const workspace = app.workspaces[0];
  if (!workspace) throw new Error("workspace fixture is missing");
  Object.assign(workspace, { rootPath, location: { kind: "local", rootPath } });
  app.uiAnswers.set("workspace.folders", { folders: [] });
  app.uiAnswers.set("chat.outsideFiles", { files: mentioned, standing, agent: [] });
  app.uiAnswers.set("chat.fileLinks", (args: unknown) => ({
    candidates: candidates((args as { links: Parameters<Candidates>[0] }).links),
  }));
  app.uiAnswers.set("chat.sourcesPresent", (args: unknown) => ({
    present: present((args as { sources: unknown[] }).sources),
  }));
  const grants = new FileGrants();
  const serve = serveWith(() => app.services, {
    files: { fs: async () => provider(rootPath), shrink: () => null },
    fileGrants: grants,
    legacyOutsideFiles: () => legacy,
  });
  const workspaceId = workspace.id;
  const ask = (
    method: string,
    params: Record<string, unknown>,
    more: Record<string, unknown> = {},
  ) =>
    serve({
      from: "qa-phone",
      method: method as never,
      params: { workspaceId, ...params },
      epoch: "e1",
      grants: true,
      ...more,
    } as never);
  return { ask, grants, app, workspaceId };
}

const answer = { kind: "answer", itemKey: "a1" };
const user = { kind: "user", itemKey: "u1" };

describe("files.resolve on the host", () => {
  test("tells each link's file, whether it reads without a grant, and blocks network paths unread", async () => {
    const { ask } = serving({
      candidates: (links) =>
        links.map((l) =>
          l.href === "gone"
            ? null
            : l.href === "two"
              ? ["/qa/none", path.join(outside, "a.txt")]
              : [l.href],
        ),
    });
    const { found } = (await ask("files.resolve", {
      tabId: "c1",
      links: [
        { href: path.join(outside, "standing.txt"), source: answer },
        { href: path.join(outside, "a.txt"), source: answer },
        { href: path.join(root, "in.txt"), source: answer },
        { href: NETWORK_LINK, source: answer },
        { href: path.join(outside, "missing.txt"), source: answer },
        { href: "gone", source: answer },
        { href: "two", source: answer },
        { href: path.join(outside, "dir"), source: answer },
      ],
    })) as { found: unknown[] };
    expect(found).toEqual([
      { path: path.join(outside, "standing.txt"), readable: true },
      { path: path.join(outside, "a.txt"), readable: false },
      { path: path.join(root, "in.txt"), readable: true },
      { blocked: true },
      null,
      null,
      { path: path.join(outside, "a.txt"), readable: false },
      null,
    ]);
  });

  test("is not taken from an agent", async () => {
    const { ask } = serving();
    for (const method of ["files.resolve", "files.grant"]) {
      await expect(
        ask(method, {
          tabId: "c1",
          links: [{ href: "/x", source: answer }],
          href: "/x",
          source: answer,
          purpose: "open",
          from: { kind: "tab", workspaceId: "pw", tabId: "pt" },
        }),
      ).rejects.toMatchObject({ code: RpcErrorCode.Forbidden });
    }
  });
});

describe("files.grant and a read with its token", () => {
  const grantFor = (
    ask: ReturnType<typeof serving>["ask"],
    href: string,
    source: unknown = answer,
  ) =>
    ask("files.grant", { tabId: "c1", href, source, purpose: "open" }) as Promise<{
      path: string;
      grant?: string;
    }>;

  test("a file outside gets a token that reads it; asking again gives the same token", async () => {
    const { ask } = serving();
    const target = path.join(outside, "a.txt");
    await expect(ask("files.read", { path: target })).rejects.toMatchObject({
      code: RpcErrorCode.Forbidden,
      data: { grant: "required" },
    });
    const first = await grantFor(ask, target);
    expect(first.path).toBe(target);
    expect(first.grant).toHaveLength(43);
    expect((await grantFor(ask, target)).grant).toBe(first.grant);
    expect(await ask("files.read", { path: target, grant: first.grant })).toMatchObject({
      kind: "text",
      text: "outside a",
    });
    await expect(
      ask("files.read", { path: path.join(outside, "b.txt"), grant: first.grant }),
    ).rejects.toMatchObject({ data: { grant: "invalid" } });
    await expect(
      ask("files.read", { path: target, grant: first.grant }, { epoch: "e2" }),
    ).rejects.toMatchObject({ data: { grant: "invalid" } });
    await expect(
      ask("files.read", { path: target, grant: "qa-unknown-token-000000000000" }),
    ).rejects.toMatchObject({ code: RpcErrorCode.GrantExpired });
    await expect(
      ask("files.read", { path: target, grant: first.grant, anywhere: true }),
    ).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams });
  });

  test("standing and in-root files need no token; folders, network and unknown links are refused", async () => {
    const { ask } = serving({
      candidates: (links) => links.map((l) => (l.href === "gone" ? null : [l.href])),
    });
    expect(await grantFor(ask, path.join(outside, "standing.txt"))).toEqual({
      path: path.join(outside, "standing.txt"),
    });
    expect(await grantFor(ask, path.join(root, "in.txt"))).toEqual({
      path: path.join(root, "in.txt"),
    });
    expect(await ask("files.read", { path: path.join(outside, "standing.txt") })).toMatchObject({
      text: "standing",
    });
    await expect(grantFor(ask, path.join(outside, "dir"))).rejects.toMatchObject({
      code: RpcErrorCode.InvalidParams,
    });
    await expect(grantFor(ask, "//qa-host/share/a.txt")).rejects.toMatchObject({
      code: RpcErrorCode.Forbidden,
    });
    await expect(grantFor(ask, "gone")).rejects.toMatchObject({ code: RpcErrorCode.NotFound });
    await expect(grantFor(ask, path.join(outside, "none.txt"))).rejects.toMatchObject({
      code: RpcErrorCode.NotFound,
    });
  });

  test("resolves a workspace attachment and keeps the existing outside attachment grant behavior", async () => {
    const inside = path.join(root, "in.txt");
    const copied = path.join(outside, "a.txt");
    const rejected = path.join(outside, "b.txt");
    const paths = new Map([
      ["in.txt", [inside]],
      [copied, [copied]],
    ]);
    const candidates: Candidates = (links) => links.map(({ href }) => paths.get(href) ?? null);
    const { ask, grants, workspaceId } = serving({ candidates });
    expect(
      await ask("files.resolve", {
        tabId: "c1",
        links: ["in.txt", rejected, copied].map((href) => ({ href, source: user })),
      }),
    ).toEqual({
      found: [{ path: inside, readable: true }, null, { path: copied, readable: false }],
    });
    expect(await grantFor(ask, "in.txt", user)).toEqual({ path: inside });
    await expect(grantFor(ask, rejected, user)).rejects.toMatchObject({
      code: RpcErrorCode.NotFound,
    });
    expect(grants.sourcesOf(workspaceId, "c1")).toEqual([]);
    const copyGrant = await grantFor(ask, copied, user);
    expect(copyGrant.path).toBe(copied);
    expect(copyGrant.grant).toHaveLength(43);

    const standing = serving({ candidates, standing: [copied] });
    expect(await grantFor(standing.ask, copied, user)).toEqual({ path: copied });
  });

  test("an older device still reads a file a chat names while the flag is on, and not once it is off", async () => {
    const target = path.join(outside, "a.txt");
    const on = serving({ mentioned: [target] });
    expect(await on.ask("files.read", { path: target }, { grants: undefined })).toMatchObject({
      text: "outside a",
    });
    await expect(on.ask("files.read", { path: target })).rejects.toMatchObject({
      data: { grant: "required" },
    });
    const off = serving({ mentioned: [target], legacy: false });
    await expect(
      off.ask("files.read", { path: target }, { grants: undefined }),
    ).rejects.toMatchObject({ data: { grant: "required" } });
  });

  test("a link in a file follows the file: its parent token, a line tail, and an expired parent", async () => {
    const { ask, grants } = serving({ standing: [] });
    const doc = path.join(outside, "doc.md");
    const parent = await grantFor(ask, doc);
    const source = { kind: "file", parent: doc, grant: parent.grant };
    const { found } = (await ask("files.resolve", {
      tabId: "c1",
      links: [
        { href: "b.txt", source },
        { href: "b.txt#L2", source },
        { href: "c.txt", source },
      ],
    })) as { found: unknown[] };
    expect(found).toEqual([
      { path: path.join(outside, "b.txt"), readable: false },
      { path: path.join(outside, "b.txt"), readable: false },
      null,
    ]);
    const child = await grantFor(ask, "b.txt", source);
    expect(await ask("files.read", { path: child.path, grant: child.grant })).toMatchObject({
      text: "child b",
    });
    grants.dropDevice("qa-phone");
    await expect(
      ask("files.resolve", { tabId: "c1", links: [{ href: "b.txt", source }] }),
    ).rejects.toMatchObject({ code: RpcErrorCode.GrantExpired });
  });

  test("a link past the first 5 MiB of a file is told apart from a missing one", async () => {
    const big = path.join(outside, "big.md");
    fs.writeFileSync(big, `${"x".repeat(5 * 1024 * 1024)}\n[late](a.txt)`);
    try {
      const { ask } = serving({ standing: [big] });
      await expect(grantFor(ask, "a.txt", { kind: "file", parent: big })).rejects.toMatchObject({
        code: RpcErrorCode.NotFound,
        data: { reason: "beyond" },
      });
    } finally {
      fs.rmSync(big);
    }
  });

  test("a token whose part of the chat was rewound away is withdrawn", async () => {
    let here = true;
    const { ask, grants, app, workspaceId } = serving({ present: (s) => s.map(() => here) });
    const target = path.join(outside, "a.txt");
    const { grant } = await grantFor(ask, target);
    await sourcesChanged(app.services, grants, workspaceId, "c1");
    expect(await ask("files.read", { path: target, grant })).toMatchObject({ text: "outside a" });
    here = false;
    await sourcesChanged(app.services, grants, workspaceId, "c1");
    await expect(ask("files.read", { path: target, grant })).rejects.toMatchObject({
      code: RpcErrorCode.Forbidden,
      data: { grant: "invalid" },
    });
  });
});

describe("a network link the host could fold into a local path", () => {
  const local = path.join(outside, "a.txt");
  const slashed = local.split(path.sep).join("/").replace(/^\//, "");
  const forms = [
    "//qa-host/share/a.txt",
    String.raw`\\qa-host\share\a.txt`,
    String.raw`\/qa-host/share/a.txt`,
    String.raw`/\qa-host\share\a.txt`,
    `//?/${slashed}`,
    `//./${slashed}`,
    `//${slashed}`,
    `\\\\?\\${slashed.replace(/\//g, "\\")}`,
  ];
  const network = path.join(outside, "net.md");
  fs.writeFileSync(network, forms.map((form) => `[x](${form})`).join("\n"));

  const sources = async (ask: ReturnType<typeof serving>["ask"]) => {
    const parent = (await ask("files.grant", {
      tabId: "c1",
      href: network,
      source: answer,
      purpose: "open",
    })) as { grant: string };
    return [answer, { kind: "file", parent: network, grant: parent.grant }];
  };

  test.each(
    forms,
  )("%s is blocked from a chat and from a file, though the folded file exists", async (form) => {
    expect(fs.existsSync(local)).toBe(true);
    const { ask } = serving({
      standing: [],
      candidates: (links) =>
        links.map((l) => [networkLinkPath(cleanLinkHref(l.href)) ?? cleanLinkHref(l.href)]),
    });
    for (const source of await sources(ask)) {
      expect(await ask("files.resolve", { tabId: "c1", links: [{ href: form, source }] })).toEqual({
        found: [{ blocked: true }],
      });
      await expect(
        ask("files.grant", { tabId: "c1", href: form, source, purpose: "open" }),
      ).rejects.toMatchObject({
        code: RpcErrorCode.Forbidden,
        message: "that file is on a network or device path not opened from another device",
      });
    }
  });
});

describe("a Windows path link written with backslashes", () => {
  test("is found under a dot folder as written, from a chat and from a file", async () => {
    const dotted = path.join(outside, ".cfg");
    fs.mkdirSync(dotted, { recursive: true });
    const target = path.join(dotted, "c.txt");
    fs.writeFileSync(target, "dotted c");
    const written =
      process.platform === "win32" ? target : target.replace(`${path.sep}.cfg`, "/\\.cfg");
    const doc = path.join(outside, "dotted.md");
    fs.writeFileSync(doc, `See [c](${written}).`);
    const { ask } = serving({ standing: [] });
    const parent = (await ask("files.grant", {
      tabId: "c1",
      href: doc,
      source: answer,
      purpose: "open",
    })) as { grant: string };
    for (const source of [answer, { kind: "file", parent: doc, grant: parent.grant }]) {
      const href = source.kind === "file" ? written : target;
      expect(await ask("files.resolve", { tabId: "c1", links: [{ href, source }] })).toEqual({
        found: [{ path: target, readable: false }],
      });
      const granted = (await ask("files.grant", {
        tabId: "c1",
        href,
        source,
        purpose: "open",
      })) as { path: string; grant: string };
      expect(await ask("files.read", { path: granted.path, grant: granted.grant })).toMatchObject({
        text: "dotted c",
      });
    }
  });
});

describe("a long file whose links are resolved together", () => {
  test("is read once for all of them, with each link's answer as before", async () => {
    const doc = path.join(outside, "long.md");
    let text = "";
    for (let i = 0; text.length < 1_000_000; i++) {
      text += `- see [file ${i}](f${i}.txt) and \`code ${i}\`\n`;
    }
    fs.writeFileSync(doc, text);
    fs.writeFileSync(path.join(outside, "f0.txt"), "first");
    const { ask } = serving({ standing: [] });
    const parent = (await ask("files.grant", {
      tabId: "c1",
      href: doc,
      source: answer,
      purpose: "open",
    })) as { grant: string };
    const source = { kind: "file", parent: doc, grant: parent.grant };
    const links = Array.from({ length: 64 }, (_, i) => ({ href: `f${i * 2}.txt`, source }));
    links.push({ href: "unlinked.txt", source });
    const started = performance.now();
    const { found } = (await ask("files.resolve", { tabId: "c1", links })) as {
      found: unknown[];
    };
    expect(performance.now() - started).toBeLessThan(2000);
    expect(found[0]).toEqual({ path: path.join(outside, "f0.txt"), readable: false });
    expect(found.slice(1)).toEqual(links.slice(1).map(() => null));
  }, 120_000);
});

describe("a workspace whose folder is reached through a link", () => {
  test("reads a file named by the folder's real path directly", async () => {
    const linkedRoot = path.join(tmp, "linked-w");
    fs.symlinkSync(root, linkedRoot, "junction");
    try {
      const { ask } = serving({ rootPath: linkedRoot });
      expect(await ask("files.read", { path: path.join(root, "in.txt") })).toMatchObject({
        text: "inside",
      });
      expect(await ask("files.read", { path: path.join(linkedRoot, "in.txt") })).toMatchObject({
        text: "inside",
      });
      expect(await ask("files.list", { path: root })).toMatchObject({
        entries: [{ name: "in.txt" }],
      });
    } finally {
      fs.rmSync(linkedRoot);
    }
  });
});

describe("a link inside the workspace that leads out of it", () => {
  const rootPath = path.join(tmp, "with-link");
  const href = "link-out/b.txt";
  const target = path.join(rootPath, href);
  const parent = path.join(rootPath, "doc.md");

  beforeAll(() => {
    fs.mkdirSync(rootPath);
    fs.symlinkSync(outside, path.join(rootPath, "link-out"), "junction");
    fs.writeFileSync(parent, `Read [b](${href}) next.`);
  });

  test("shows an unreadable link from a chat or file without issuing a grant", async () => {
    const { ask, grants, workspaceId } = serving({
      rootPath,
      candidates: (links) => links.map((link) => [path.join(rootPath, link.href)]),
    });
    const missing = "link-out/missing.txt";
    const links = [
      { href, source: answer },
      { href, source: { kind: "file", parent } },
      { href, source: user },
      { href: missing, source: answer },
    ];
    expect(await ask("files.resolve", { tabId: "c1", links })).toEqual({
      found: [
        { path: target, readable: false },
        { path: target, readable: false },
        { path: target, readable: false },
        { path: path.join(rootPath, missing), readable: false },
      ],
    });
    for (const link of links) {
      await expect(
        ask("files.grant", { tabId: "c1", ...link, purpose: "open" }),
      ).rejects.toMatchObject({
        code: RpcErrorCode.Forbidden,
        data: undefined,
        message: "link-out is a link: what it points to is not read",
      });
    }
    expect(grants.sourcesOf(workspaceId, "c1")).toEqual([]);
  });
});
