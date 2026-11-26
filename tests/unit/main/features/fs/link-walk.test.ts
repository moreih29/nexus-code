import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  type LinkFs,
  MAX_LINK_STEPS,
  networkLinkOf,
} from "../../../../../src/main/features/fs/link-walk";

function fakeFs(links: Record<string, string>, missing: string[] = []) {
  const looked: string[] = [];
  const fs: LinkFs = {
    async lstat(p) {
      looked.push(p);
      if (missing.some((m) => p === m || p.startsWith(`${m}/`) || p.startsWith(`${m}\\`))) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return { isSymbolicLink: () => p in links };
    },
    async readlink(p) {
      const target = links[p];
      if (target === undefined) throw new Error(`not a link: ${p}`);
      return target;
    },
  };
  return { fs, looked };
}

describe("walking links one step at a time", () => {
  test("a link to an automount path is found before anything past it is looked at", async () => {
    const { fs, looked } = fakeFs({ "/tmp/a.png": "/net/qa/a.png" });
    expect(await networkLinkOf("/tmp/a.png", fs, path.posix)).toBe("/net/qa/a.png");
    expect(looked).toEqual(["/tmp", "/tmp/a.png"]);
  });

  test("a linked folder on the way, a relative link and a chain of links", async () => {
    const folder = fakeFs({ "/Users/me/share": "/Network/Servers/qa" });
    expect(await networkLinkOf("/Users/me/share/sub/a.txt", folder.fs, path.posix)).toBe(
      "/Network/Servers/qa",
    );
    expect(folder.looked).not.toContain("/Users/me/share/sub");
    const chain = fakeFs({
      "/a/near": "far/x.txt",
      "/a/far": "../../System/Volumes/Data/net/qa",
    });
    expect(await networkLinkOf("/a/near", chain.fs, path.posix)).toBe(
      "/System/Volumes/Data/net/qa",
    );
    const dotted = fakeFs({ "/a/b": "../tmp/../net/qa" });
    expect(await networkLinkOf("/a/b", dotted.fs, path.posix)).toBe("/net/qa");
  });

  test("a UNC target written with either slash is found", async () => {
    for (const target of ["//h/s/a.png", "\\\\h\\s\\a.png"]) {
      const { fs } = fakeFs({ "/tmp/a.png": target });
      expect(await networkLinkOf("/tmp/a.png", fs, path.posix)).toBe(target);
    }
  });

  test("on Windows, a junction to a share and a device target are found; a drive link is followed", async () => {
    const share = fakeFs({ "C:\\Users\\me\\nas": "\\\\nas\\share" });
    expect(await networkLinkOf("C:\\Users\\me\\nas\\a.txt", share.fs, path.win32)).toBe(
      "\\\\nas\\share",
    );
    const device = fakeFs({ "C:\\a": "\\\\.\\PhysicalDrive0" });
    expect(await networkLinkOf("C:\\a", device.fs, path.win32)).toBe("\\\\.\\PhysicalDrive0");
    const drive = fakeFs({ "C:\\a": "\\\\?\\D:\\real" });
    expect(await networkLinkOf("C:\\a\\b.txt", drive.fs, path.win32)).toBeNull();
    expect(drive.looked).toContain("D:\\real\\b.txt");
  });

  test("local links, a missing file and a backslash in a POSIX name pass", async () => {
    const local = fakeFs({ "/tmp/a.txt": "/Users/me/real.txt" });
    expect(await networkLinkOf("/tmp/a.txt", local.fs, path.posix)).toBeNull();
    const gone = fakeFs({}, ["/tmp/gone"]);
    expect(await networkLinkOf("/tmp/gone/a.txt", gone.fs, path.posix)).toBeNull();
    const named = fakeFs({});
    await networkLinkOf("/tmp/a\\b.txt", named.fs, path.posix);
    expect(named.looked).toEqual(["/tmp", "/tmp/a\\b.txt"]);
  });

  test("an asked network path is left alone: the caller judges it", async () => {
    const { fs, looked } = fakeFs({});
    expect(await networkLinkOf("/net/qa/a.txt", fs, path.posix)).toBeNull();
    expect(looked).toEqual([]);
  });

  test(`a loop stops after ${MAX_LINK_STEPS} links`, async () => {
    const { fs } = fakeFs({ "/a/x": "y", "/a/y": "x" });
    await expect(networkLinkOf("/a/x", fs, path.posix)).rejects.toMatchObject({ code: "ELOOP" });
  });
});
