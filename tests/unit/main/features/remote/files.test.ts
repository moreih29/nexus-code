/** A workspace's files as another device reads them: only its folders, never through a link. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as nodeFs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_LIST_ENTRIES } from "../../../../../packages/remote-protocol/src";
import type { FsProvider } from "../../../../../src/main/features/fs/bridge/provider";
import {
  listFiles,
  placeOf,
  type RemoteFiles,
  readFile,
  untrackedReader,
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
  const range = (bytes: Buffer, length: number, offset = 0) => ({
    kind: "ok" as const,
    base64: bytes.subarray(offset, offset + length).toString("base64"),
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
    readRange: async (rel: string, offset: number, length: number) =>
      range(node(rel).bytes ?? Buffer.alloc(0), length, offset),
    readBinary: async (rel: string) => range(node(rel).bytes ?? Buffer.alloc(0), Infinity),
  } as unknown as FsProvider;
}

function files(
  tree: Record<string, Node>,
  shrunk: string | null = null,
  { folders = ["/home/me/shared"], kind = "ssh" as FsProvider["kind"] } = {},
): RemoteFiles {
  return {
    fs: async () => fakeFs(tree, kind),
    folders: async () => folders,
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

  test("a backslash is a character of a name in a POSIX folder", () => {
    expect(placeOf(root, [], String.raw`a\b`)).toEqual({ kind: "workspace", rel: String.raw`a\b` });
    expect(placeOf(root, [], String.raw`..\x`)).toEqual({
      kind: "workspace",
      rel: String.raw`..\x`,
    });
  });
});

describe("where a path is, in a Windows folder", () => {
  const win = String.raw`C:\Users\me\app`;

  test("inside the workspace's folder: either separator, any case, parts between /", () => {
    expect(placeOf(win, [], "")).toEqual({ kind: "workspace", rel: "" });
    expect(placeOf(win, [], String.raw`src\.\a.ts`)).toEqual({
      kind: "workspace",
      rel: "src/a.ts",
    });
    expect(placeOf(win, [], "src/a.ts")).toEqual({ kind: "workspace", rel: "src/a.ts" });
    expect(placeOf(win, [], "C:\\Users\\me\\app\\src\\")).toEqual({
      kind: "workspace",
      rel: "src",
    });
    expect(placeOf(win, [], "c:/users/ME/App/src/a.ts")).toEqual({
      kind: "workspace",
      rel: "src/a.ts",
    });
    expect(placeOf(win, [], String.raw`C:\Users\me\app/src`)).toEqual({
      kind: "workspace",
      rel: "src",
    });
    expect(placeOf(win, [], "C:/Users/me/app")).toEqual({ kind: "workspace", rel: "" });
  });

  test("a drive's or a share's own folder as the workspace's", () => {
    expect(placeOf("C:\\", [], String.raw`c:\x\y`)).toEqual({ kind: "workspace", rel: "x/y" });
    expect(placeOf(String.raw`\\srv\share\app`, [], "//srv/share/app/a")).toEqual({
      kind: "workspace",
      rel: "a",
    });
  });

  test("in a folder a chat was given, written as Windows writes it", () => {
    expect(placeOf(win, ["D:\\shared\\"], "d:/Shared/x")).toEqual({
      kind: "folder",
      absolute: String.raw`d:\Shared\x`,
    });
  });

  test("nowhere else: not by climbing, another drive, the current drive's root, or a device", () => {
    for (const outside of [
      String.raw`..\etc`,
      String.raw`src\..\..\x`,
      "src/../../x",
      String.raw`C:\Users\me\apple`,
      String.raw`C:\Users\me\app\..\other`,
      String.raw`C:\Windows\win.ini`,
      String.raw`\Windows`,
      "/Windows",
      "C:x",
      "D:\\",
      String.raw`\\srv\share\x`,
      String.raw`\\?\C:\Users\me\app\x`,
    ]) {
      expect(() => placeOf(win, [String.raw`D:\shared`], outside)).toThrow("outside");
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

/** A PNG whose header says `width` by `height`, padded to `bytes`. */
function pngSaying(width: number, height: number, bytes: number): Buffer {
  const b = Buffer.alloc(bytes, 1);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

describe("reading a file", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(8)]);
  const tree: Record<string, Node> = {
    "a.ts": text("한글 text"),
    "bin.dat": { type: "file", bytes: Buffer.from([1, 0, 2]) },
    "pic.png": { type: "file", bytes: png },
    big: { type: "file", bytes: Buffer.alloc(2_000_000, "x") },
    "huge.png": { type: "file", bytes: pngSaying(4000, 3000, 900_000) },
    // A small file whose header says 50000 by 50000: decoding it would take 10 GB.
    "bomb.png": { type: "file", bytes: pngSaying(50_000, 50_000, 900_000) },
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
    expect(await read("bomb.png", undefined, "c21hbGw=")).toMatchObject({ kind: "binary" });
  });

  test("as bytes, a piece of whatever it holds, from where asked", async () => {
    const bytes = (path: string, more: { offset?: number; length?: number } = {}) =>
      readFile(files(tree), root, { workspaceId: ws, path, as: "bytes", ...more });
    expect(await bytes("bin.dat")).toEqual({
      kind: "bytes",
      path: "/src/app/bin.dat",
      data: Buffer.from([1, 0, 2]).toString("base64"),
      offset: 0,
      size: 3,
    });
    // An image, or text, as it is: not drawn, not decoded.
    expect(await bytes("pic.png", { offset: 4, length: 4 })).toMatchObject({
      data: Buffer.alloc(4).toString("base64"),
      offset: 4,
      size: 12,
    });
    // At most MAX_BYTES_CHUNK when not said; fewer at the end, none past it.
    const head = await bytes("big");
    expect(head.kind === "bytes" && Buffer.from(head.data, "base64").length).toBe(512 * 1024);
    expect(await bytes("big", { offset: 1_999_999, length: 10 })).toMatchObject({
      data: Buffer.from("x").toString("base64"),
      size: 2_000_000,
    });
    expect(await bytes("big", { offset: 3_000_000 })).toMatchObject({ data: "", size: 2_000_000 });
    await expect(bytes("src")).rejects.toMatchObject({ code: -32602 });
    await expect(bytes("link")).rejects.toMatchObject({ code: 1002 });
    await expect(bytes("../out")).rejects.toMatchObject({ code: 1002 });
    // Where to start is taken only with bytes.
    await expect(
      readFile(files(tree), root, { workspaceId: ws, path: "a.ts", offset: 2 }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  test("refuses a folder, a link, and the workspace's folder itself", async () => {
    await expect(read("src")).rejects.toMatchObject({ code: -32602 });
    await expect(read("link")).rejects.toMatchObject({ code: 1002 });
    await expect(read("")).rejects.toThrow();
    await expect(read("gone.ts")).rejects.toMatchObject({ code: 1001 });
  });

  test("a folder a chat was given is read only on this computer: its host's agent follows links", async () => {
    await expect(read("/home/me/shared/notes.md")).rejects.toMatchObject({ code: 1003 });
  });
});

describe("a Windows workspace's files", () => {
  const win = String.raw`C:\Users\me\app`;
  const tree: Record<string, Node> = {
    src: { type: "dir" },
    "src/a.ts": text("a"),
    out: { type: "symlink" },
    "out/secret.txt": text("secret"),
  };
  const opts = { folders: [String.raw`D:\shared`] };

  test("tell their folder as Windows writes it, however it was asked", async () => {
    const list = (path: string) =>
      listFiles(files(tree, null, opts), win, { workspaceId: ws, path });
    expect((await list("")).path).toBe(win);
    expect((await list("src")).path).toBe(String.raw`C:\Users\me\app\src`);
    expect((await list("c:/users/me/app/src")).path).toBe(String.raw`C:\Users\me\app\src`);
    const got = await readFile(files(tree, null, opts), win, {
      workspaceId: ws,
      path: String.raw`src\a.ts`,
    });
    expect(got).toMatchObject({ kind: "text", path: String.raw`C:\Users\me\app\src\a.ts` });
  });

  test("refuse a path through a link, written with either separator", async () => {
    for (const path of [
      "out/secret.txt",
      String.raw`out\secret.txt`,
      String.raw`C:\Users\me\app\out\secret.txt`,
    ]) {
      await expect(
        readFile(files(tree, null, opts), win, { workspaceId: ws, path }),
      ).rejects.toMatchObject({ code: 1002 });
    }
    await expect(
      listFiles(files(tree, null, opts), win, { workspaceId: ws, path: "out\\" }),
    ).rejects.toMatchObject({ code: 1002 });
  });
});

describe("a folder a chat was given, on this computer", () => {
  let top = "";
  let work = "";
  let shared = "";

  beforeAll(async () => {
    top = await nodeFs.mkdtemp(path.join(os.tmpdir(), "remote-files-"));
    work = path.join(top, "work");
    shared = path.join(top, "shared");
    await nodeFs.mkdir(work);
    await nodeFs.mkdir(path.join(shared, "sub"), { recursive: true });
    await nodeFs.writeFile(path.join(shared, "notes.md"), "# notes");
  });
  afterAll(async () => {
    await nodeFs.rm(top, { recursive: true, force: true });
  });

  const local = () => files({}, null, { folders: [shared], kind: "local" });

  test("is listed by its own path", async () => {
    const got = await listFiles(local(), work, { workspaceId: ws, path: shared });
    expect(got.path).toBe(shared);
    expect(got.entries).toEqual([
      { name: "sub", kind: "dir" },
      { name: "notes.md", kind: "file", size: 7 },
    ]);
  });

  test.if(process.platform === "win32")(
    "on Windows, with either separator, in any case",
    async () => {
      const asked = path.join(shared, "sub").replaceAll("\\", "/").toUpperCase();
      const got = await listFiles(local(), work, { workspaceId: ws, path: asked });
      expect(got.path.toLowerCase()).toBe(path.join(shared, "sub").toLowerCase());
      expect(got.entries).toEqual([]);
    },
  );
});

describe("a file git does not track yet, read for its diff", () => {
  const tree: Record<string, Node> = {
    "notes.txt": text("a\nb\n"),
    key: { type: "symlink" },
    linked: { type: "symlink" },
    "linked/inner.txt": text("through a link"),
  };
  const read = untrackedReader(
    async () => fakeFs(tree),
    (id) => (id === ws ? root : undefined),
  );

  test("is read from the workspace's folder", async () => {
    expect(await read(ws, "/src/app/notes.txt", 100)).toBe("a\nb\n");
    expect(await read(ws, "/src/app/notes.txt", 2)).toBe("a\n");
  });

  test("not through a link, nor outside the folder, nor of no workspace", async () => {
    await expect(read(ws, "/src/app/key", 100)).rejects.toMatchObject({
      code: 1002,
      message: "key is a link: what it points to is not read",
    });
    await expect(read(ws, "/src/app/linked/inner.txt", 100)).rejects.toMatchObject({
      code: 1002,
    });
    await expect(read(ws, "/home/me/.ssh/id_ed25519", 100)).rejects.toMatchObject({
      code: 1002,
    });
    await expect(read("w2", "/src/app/notes.txt", 100)).rejects.toMatchObject({ code: 1001 });
  });
});
