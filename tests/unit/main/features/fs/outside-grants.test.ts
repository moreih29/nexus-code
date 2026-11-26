import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearOutsideGrants,
  isOutsideGranted,
  resolveOutsideGrant,
  setOutsideGrant,
} from "../../../../../src/main/features/fs/outside-grants";

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-outside-")));
const site = path.join(tmp, "site");
const secret = path.join(tmp, "secret.txt");
fs.mkdirSync(site);
fs.writeFileSync(path.join(site, "index.html"), "<p>hi</p>");
fs.writeFileSync(path.join(site, "style.css"), "p{}");
fs.writeFileSync(secret, "key");
if (process.platform !== "win32") {
  fs.symlinkSync(secret, path.join(site, "leak.txt"));
  fs.symlinkSync(secret, path.join(tmp, "named-link.txt"));
}

afterEach(() => clearOutsideGrants());
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("outside grants", () => {
  test("a granted file or a file in a granted folder, in that workspace only", () => {
    setOutsideGrant("ws", "tab-1", ["/tmp/out.png"], ["/tmp/site"]);
    expect(isOutsideGranted("ws", "/tmp/out.png")).toBe(true);
    expect(isOutsideGranted("ws", "/tmp/site/a/b.css")).toBe(true);
    expect(isOutsideGranted("ws", "/tmp/site/../other.png")).toBe(false);
    expect(isOutsideGranted("ws", "/tmp/sitemap.xml")).toBe(false);
    expect(isOutsideGranted("ws", "/tmp/site")).toBe(false);
    expect(isOutsideGranted("ws-2", "/tmp/out.png")).toBe(false);
    expect(isOutsideGranted("ws", "tmp/out.png")).toBe(false);
  });

  test("a tab's grant replaces its last, and an empty one revokes it", () => {
    setOutsideGrant("ws", "tab-1", ["/a/one.png"], []);
    setOutsideGrant("ws", "tab-2", ["/a/two.png"], []);
    setOutsideGrant("ws", "tab-1", ["/a/three.png"], []);
    expect(isOutsideGranted("ws", "/a/one.png")).toBe(false);
    expect(isOutsideGranted("ws", "/a/three.png")).toBe(true);
    setOutsideGrant("ws", "tab-2", [], []);
    expect(isOutsideGranted("ws", "/a/two.png")).toBe(false);
  });

  test("a Windows path from its drive, with either slash and in any case", () => {
    setOutsideGrant(
      "ws",
      "tab",
      [String.raw`C:\Users\u\AppData\Local\Temp\claude\s\tasks\b1.output`],
      ["C:/Users/u/site"],
    );
    expect(isOutsideGranted("ws", "C:/Users/u/AppData/Local/Temp/claude/s/tasks/b1.output")).toBe(
      true,
    );
    expect(
      isOutsideGranted("ws", String.raw`c:\users\U\appdata\local\temp\claude\s\tasks\B1.output`),
    ).toBe(true);
    expect(isOutsideGranted("ws", String.raw`C:\Users\u\site\a\b.css`)).toBe(true);
    expect(isOutsideGranted("ws", "C:/Users/u/site/../other.png")).toBe(false);
    expect(isOutsideGranted("ws", "C:/Users/u/sitemap.xml")).toBe(false);
    expect(isOutsideGranted("ws", "D:/Users/u/site/a.css")).toBe(false);
  });

  test("neither a drive nor the root itself, nor a climb out of the drive", () => {
    setOutsideGrant("ws", "tab", ["/", "C:/", String.raw`C:\..\x.txt`, "C:"], ["/", "D:\\"]);
    expect(isOutsideGranted("ws", "/etc/hosts")).toBe(false);
    expect(isOutsideGranted("ws", "D:/secret.txt")).toBe(false);
    expect(isOutsideGranted("ws", "x.txt")).toBe(false);
    expect(isOutsideGranted("ws", "C:/x.txt")).toBe(false);
  });

  test("a file in a granted folder is read where it is", async () => {
    setOutsideGrant("ws", "tab", [], [site]);
    expect(await resolveOutsideGrant("ws", path.join(site, "style.css"))).toBe(
      path.join(site, "style.css"),
    );
    expect(await resolveOutsideGrant("ws", path.join(site, "absent.css"))).toBeNull();
    expect(await resolveOutsideGrant("ws", secret)).toBeNull();
  });

  test("a path no grant names never reaches the disk", async () => {
    const realpath = spyOn(fs.promises, "realpath");
    try {
      setOutsideGrant("ws", "tab", [path.join(site, "index.html")], [site]);
      expect(await resolveOutsideGrant("ws", secret)).toBeNull();
      expect(await resolveOutsideGrant("ws-2", path.join(site, "style.css"))).toBeNull();
      expect(await resolveOutsideGrant("ws", path.join(tmp, "sitemap.xml"))).toBeNull();
      expect(realpath).not.toHaveBeenCalled();

      expect(await resolveOutsideGrant("ws", path.join(site, "index.html"))).toBe(
        path.join(site, "index.html"),
      );
      expect(realpath.mock.calls).toEqual([[path.join(site, "index.html").replace(/\\/g, "/")]]);
    } finally {
      realpath.mockRestore();
    }
  });

  test("an automount path is granted only as a file the user opened", () => {
    const automount = [
      "/net/host.example/share/a.png",
      "/Network/Servers/host.example/a.png",
      "/System/Volumes/Data/net/host/a.png",
      "/tmp/../net/host/a.png",
    ];
    setOutsideGrant("ws", "answer", automount, ["/net/host.example", "/System/Volumes"]);
    for (const asked of automount)
      expect([asked, isOutsideGranted("ws", asked)]).toEqual([asked, false]);
    expect(isOutsideGranted("ws", "/net/host.example/share/b.png")).toBe(false);

    setOutsideGrant("ws", "clicked", [], [], { opened: ["/net/host.example/share/a.png"] });
    expect(isOutsideGranted("ws", "/net/host.example/share/a.png")).toBe(true);
    expect(isOutsideGranted("ws", "/net/host.example/share/b.png")).toBe(false);
    setOutsideGrant("ws", "clicked", [], [], { opened: [] });
    expect(isOutsideGranted("ws", "/net/host.example/share/a.png")).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "an automount path an answer named is never resolved on disk",
    async () => {
      const realpath = spyOn(fs.promises, "realpath").mockResolvedValue("/net/host/a.png");
      try {
        setOutsideGrant("ws", "answer", ["/net/host/a.png"], ["/System/Volumes"]);
        expect(await resolveOutsideGrant("ws", "/net/host/a.png")).toBeNull();
        expect(await resolveOutsideGrant("ws", "/System/Volumes/Data/net/host/a.png")).toBeNull();
        expect(realpath).not.toHaveBeenCalled();

        setOutsideGrant("ws", "clicked", [], [], { opened: ["/net/host/a.png"] });
        expect(await resolveOutsideGrant("ws", "/net/host/a.png")).toBe("/net/host/a.png");
        expect(realpath.mock.calls).toEqual([["/net/host/a.png"]]);
      } finally {
        realpath.mockRestore();
      }
    },
  );

  test.if(process.platform === "win32")(
    "a Windows file is read however its path is written",
    async () => {
      setOutsideGrant("ws", "tab", [], [site.toUpperCase()]);
      const css = path.join(site, "style.css");
      expect(await resolveOutsideGrant("ws", css.replace(/\\/g, "/").toLowerCase())).toBe(css);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a file granted by name is read where its link points",
    async () => {
      setOutsideGrant("ws", "tab", [path.join(tmp, "named-link.txt")], []);
      expect(await resolveOutsideGrant("ws", path.join(tmp, "named-link.txt"))).toBe(secret);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a link in a granted folder does not reach out of it",
    async () => {
      setOutsideGrant("ws", "tab", [], [site]);
      expect(await resolveOutsideGrant("ws", path.join(site, "leak.txt"))).toBeNull();
    },
  );
});
