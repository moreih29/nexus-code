/**
 * folders.list: another device going through this one's folders to add a
 * workspace: folders only, hidden ones on asking, by name, and the paths
 * it may not read or that are none.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FOLDERS } from "../../../../../packages/remote-protocol/src";
import {
  type FolderSystem,
  hiddenOf,
  listFolders,
  refusedFolder,
} from "../../../../../src/main/features/remote/folders";

const made: string[] = [];
async function tree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "folders-"));
  made.push(root);
  return root;
}
afterEach(async () => {
  for (const root of made.splice(0)) {
    await chmod(join(root, "locked"), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

const system = (home: string, over: Partial<FolderSystem> = {}): FolderSystem => ({
  platform: "darwin",
  home: () => home,
  ...over,
});

describe("listing folders", () => {
  test("folders and links to them only, by name case aside; hidden ones on asking", async () => {
    const root = await tree();
    for (const dir of ["beta", "Alpha", ".git", "gamma"]) await mkdir(join(root, dir));
    await writeFile(join(root, "notes.txt"), "x");
    await symlink(join(root, "gamma"), join(root, "delta"));
    await symlink(join(root, "notes.txt"), join(root, "file-link"));
    const listed = await listFolders({ path: root }, system(root));
    expect(listed.entries.map((e) => e.name)).toEqual(["Alpha", "beta", "delta", "gamma"]);
    expect(listed).toMatchObject({ path: root, home: root, parent: join(root, "..") });
    const all = await listFolders({ path: root, hidden: true }, system(root));
    expect(all.entries.map((e) => e.name)).toContain(".git");
  });

  test("the home folder when no path is given", async () => {
    const root = await tree();
    await mkdir(join(root, "work"));
    expect((await listFolders({}, system(root))).entries).toEqual([{ name: "work" }]);
  });

  test("at most so many, told as cut short", async () => {
    const root = await tree();
    await Promise.all(
      Array.from({ length: MAX_FOLDERS + 2 }, (_, i) =>
        mkdir(join(root, `d${String(i).padStart(5, "0")}`)),
      ),
    );
    const listed = await listFolders({ path: root }, system(root));
    expect(listed.entries).toHaveLength(MAX_FOLDERS);
    expect(listed.truncated).toBe(true);
  });

  test("a relative path, no folder, and one it may not read", async () => {
    const root = await tree();
    await writeFile(join(root, "notes.txt"), "x");
    await expect(listFolders({ path: "rel/dir" }, system(root))).rejects.toMatchObject({
      code: -32602,
    });
    await expect(listFolders({ path: join(root, "none") }, system(root))).rejects.toMatchObject({
      code: 1001,
    });
    await expect(
      listFolders({ path: join(root, "notes.txt") }, system(root)),
    ).rejects.toMatchObject({ code: 1001 });
    if (process.platform !== "win32") {
      await mkdir(join(root, "locked"));
      await chmod(join(root, "locked"), 0o000);
      await expect(listFolders({ path: join(root, "locked") }, system(root))).rejects.toMatchObject(
        { code: 1002, message: "permission denied" },
      );
    }
  });

  test("Windows: its hidden attribute hides a folder, and its drives are told", async () => {
    const root = await tree();
    for (const dir of ["AppData", "Documents"]) await mkdir(join(root, dir));
    const windows = system(root, {
      platform: "win32",
      hiddenIn: async () => new Set(["AppData"]),
      drives: async () => ["C:\\", "D:\\"],
    });
    const listed = await listFolders({ path: root }, windows);
    expect(listed.entries).toEqual([{ name: "Documents" }]);
    expect(listed.roots).toEqual(["C:\\", "D:\\"]);
  });

  test("attrib's listing: the names marked H", () => {
    const listing = [
      "A                    C:\\Users\\me\\notes.txt",
      "     H               C:\\Users\\me\\AppData",
      "                     C:\\Users\\me\\Documents",
      "  S H                C:\\Users\\me\\NTUSER.DAT",
      "",
    ].join("\r\n");
    expect([...hiddenOf(listing)].sort()).toEqual(["AppData", "NTUSER.DAT"]);
  });
});

describe("a folder another device may add", () => {
  test("Windows: not a drive's root, the home folder or above it, nor a drive's system folders", () => {
    const home = "C:\\Users\\me";
    const refused = (dir: string) => refusedFolder(dir, home, "win32");
    expect(refused("C:\\")).toBe("a drive's root");
    expect(refused("D:\\")).toBe("a drive's root");
    expect(refused("c:\\users\\ME")).toBe("the home folder");
    expect(refused("C:\\Users")).toBe("a folder that holds the home folder");
    expect(refused("C:\\Windows\\System32")).toBe("a system folder");
    expect(refused("D:\\Program Files\\app")).toBe("a system folder");
    expect(refused("C:\\Users\\me\\work\\app")).toBeUndefined();
    expect(refused("D:\\src\\app")).toBeUndefined();
  });

  test("macOS and Linux: not the root, the home folder or above it, the system's, nor /tmp itself", () => {
    expect(refusedFolder("/", "/Users/me", "darwin")).toBe("a drive's root");
    expect(refusedFolder("/users/ME", "/Users/me", "darwin")).toBe("the home folder");
    expect(refusedFolder("/Users", "/Users/me", "darwin")).toBe(
      "a folder that holds the home folder",
    );
    expect(refusedFolder("/usr/local/lib", "/Users/me", "darwin")).toBe("a system folder");
    expect(refusedFolder("/private/etc", "/Users/me", "darwin")).toBe("a system folder");
    expect(refusedFolder("/private/tmp", "/Users/me", "darwin")).toBe(
      "a folder that holds others' files",
    );
    expect(refusedFolder("/private/tmp/app", "/Users/me", "darwin")).toBeUndefined();
    expect(refusedFolder("/Users/me/src/app", "/Users/me", "darwin")).toBeUndefined();
    expect(refusedFolder("/etc/nginx", "/home/me", "linux")).toBe("a system folder");
    expect(refusedFolder("/home", "/home/me", "linux")).toBe("a folder that holds the home folder");
    expect(refusedFolder("/srv/site", "/home/me", "linux")).toBeUndefined();
    // Linux names differ by case.
    expect(refusedFolder("/home/ME", "/home/me", "linux")).toBeUndefined();
  });
});
