/** A workspace's files as another device reads them: only its folders, never through a link. */
import { describe, expect, test } from "bun:test";
import { MAX_LIST_ENTRIES } from "../../../../../packages/remote-protocol/src";
import type { FsProvider } from "../../../../../src/main/features/fs/bridge/provider";
import {
  listFiles,
  placeOf,
  type RemoteFiles,
  readFile,
} from "../../../../../src/main/features/remote/files";

interface Node {
  type: "file" | "dir" | "symlink";
  bytes?: Buffer;
}

/** A file system of `tree` (workspace-relative paths): the agent's calls, as it answers them. */
function fakeFs(tree: Record<string, Node>, kind: FsProvider["kind"] = "ssh"): FsProvider {
  const node = (rel: string) => {
    const found = rel === "" ? { type: "dir" as const } : tree[rel];
    if (!found) throw new Error(`NOT_FOUND: ${rel}`);
    return found;
  };
  const range = (bytes: Buffer, length: number) => ({
    kind: "ok" as const,
    base64: bytes.subarray(0, length).toString("base64"),
    sizeBytes: bytes.length,
    mtime: "",
  });
  return {
    kind,
    stat: async (rel: string) => {
      const n = node(rel);
      return {
        type: n.type,
        size: n.bytes?.length ?? 0,
        mtime: "",
        isSymlink: n.type === "symlink",
      };
    },
    readdir: async (rel: string) => {
      node(rel);
      const prefix = rel ? `${rel}/` : "";
      return Object.entries(tree)
        .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
        .map(([p, n]) => ({
          name: p.slice(prefix.length),
          type: n.type,
          ...(n.bytes ? { size: n.bytes.length } : {}),
        }));
    },
    readRange: async (rel: string, _offset: number, length: number) =>
      range(node(rel).bytes ?? Buffer.alloc(0), length),
    readBinary: async (rel: string) => range(node(rel).bytes ?? Buffer.alloc(0), Infinity),
  } as unknown as FsProvider;
}

function files(tree: Record<string, Node>, shrunk: string | null = null): RemoteFiles {
  return {
    fs: async () => fakeFs(tree),
    folders: async () => ["/home/me/shared"],
    shrink: () => (shrunk ? { mediaType: "image/jpeg", data: shrunk } : null),
  };
}

const root = "/src/app";
const ws = "w1";
const text = (s: string): Node => ({ type: "file", bytes: Buffer.from(s) });

describe("where a path is", () => {
  test("inside the workspace's folder, by its own path or an absolute one", () => {
    expect(placeOf(root, [], "")).toEqual({ kind: "workspace", rel: "" });
    expect(placeOf(root, [], "src/./a.ts")).toEqual({ kind: "workspace", rel: "src/a.ts" });
    expect(placeOf(root, [], "/src/app/src/")).toEqual({ kind: "workspace", rel: "src" });
    expect(placeOf(root, [], "/src/app")).toEqual({ kind: "workspace", rel: "" });
  });

  test("in a folder a chat was given, and nowhere else", () => {
    expect(placeOf(root, ["/home/me/shared/"], "/home/me/shared/x")).toEqual({
      kind: "folder",
      absolute: "/home/me/shared/x",
    });
    for (const outside of ["../etc", "src/../../x", "/src/apple", "/etc/passwd", "/home/me"]) {
      expect(() => placeOf(root, ["/home/me/shared"], outside)).toThrow("outside");
    }
  });
});

describe("listing a folder", () => {
  const tree: Record<string, Node> = {
    "b.ts": text("b"),
    src: { type: "dir" },
    "src/a.ts": text("aaa"),
    out: { type: "symlink" },
    "a.md": text("# a"),
  };

  test("its folders first, then by name; a link told as one, not followed", async () => {
    const got = await listFiles(files(tree), root, { workspaceId: ws, path: "" });
    expect(got.path).toBe("/src/app");
    expect(got.entries).toEqual([
      { name: "src", kind: "dir" },
      { name: "a.md", kind: "file", size: 3 },
      { name: "b.ts", kind: "file", size: 1 },
      { name: "out", kind: "link" },
    ]);
    expect((await listFiles(files(tree), root, { workspaceId: ws, path: "src" })).path).toBe(
      "/src/app/src",
    );
  });

  test("refuses a path through a link, a file, and one that is not there", async () => {
    const list = (path: string) => listFiles(files(tree), root, { workspaceId: ws, path });
    await expect(list("out/x")).rejects.toMatchObject({ code: 1002 });
    await expect(list("b.ts")).rejects.toMatchObject({ code: -32602 });
    await expect(list("nope")).rejects.toMatchObject({ code: 1001 });
    await expect(list("/etc")).rejects.toMatchObject({ code: 1002 });
  });

  test("a folder a chat was given is listed only on this computer", async () => {
    await expect(
      listFiles(files(tree), root, { workspaceId: ws, path: "/home/me/shared" }),
    ).rejects.toMatchObject({ code: 1003 });
  });

  test("gives so many entries, and says the rest were left out", async () => {
    const many: Record<string, Node> = {};
    for (let i = 0; i <= MAX_LIST_ENTRIES; i++) many[`f${i}`] = text("");
    const got = await listFiles(files(many), root, { workspaceId: ws, path: "" });
    expect(got.entries).toHaveLength(MAX_LIST_ENTRIES);
    expect(got.truncated).toBe(true);
  });
});

describe("reading a file", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(8)]);
  const tree: Record<string, Node> = {
    "a.ts": text("한글 text"),
    "bin.dat": { type: "file", bytes: Buffer.from([1, 0, 2]) },
    "pic.png": { type: "file", bytes: png },
    big: { type: "file", bytes: Buffer.alloc(2_000_000, "x") },
    "huge.png": { type: "file", bytes: Buffer.alloc(900_000, 1) },
    src: { type: "dir" },
    link: { type: "symlink" },
  };
  const read = (path: string, maxBytes?: number, shrunk?: string | null) =>
    readFile(files(tree, shrunk), root, {
      workspaceId: ws,
      path,
      ...(maxBytes ? { maxBytes } : {}),
    });

  test("text from its start, a character cut at the end left out", async () => {
    expect(await read("a.ts")).toEqual({
      kind: "text",
      path: "/src/app/a.ts",
      text: "한글 text",
      size: 11,
      truncated: false,
    });
    // 4 bytes: "한" whole, the half of "글" left out.
    expect(await read("a.ts", 4)).toMatchObject({ text: "한", truncated: true });
    expect(await read("big")).toMatchObject({ truncated: true, size: 2_000_000 });
  });

  test("binary told as binary; an image as it is, or drawn smaller, or binary", async () => {
    expect(await read("bin.dat")).toEqual({ kind: "binary", path: "/src/app/bin.dat", size: 3 });
    expect(await read("pic.png")).toEqual({
      kind: "image",
      path: "/src/app/pic.png",
      mediaType: "image/png",
      data: png.toString("base64"),
      size: 12,
    });
    expect(await read("huge.png", undefined, "c21hbGw=")).toMatchObject({
      kind: "image",
      mediaType: "image/jpeg",
      data: "c21hbGw=",
    });
    expect(await read("huge.png", undefined, null)).toMatchObject({ kind: "binary" });
  });

  test("refuses a folder, a link, and the workspace's folder itself", async () => {
    await expect(read("src")).rejects.toMatchObject({ code: -32602 });
    await expect(read("link")).rejects.toMatchObject({ code: 1002 });
    await expect(read("")).rejects.toThrow();
    await expect(read("gone.ts")).rejects.toMatchObject({ code: 1001 });
  });
});
