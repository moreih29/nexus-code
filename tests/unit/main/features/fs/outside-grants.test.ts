import { afterAll, afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearOutsideGrants,
  isOutsideGranted,
  resolveOutsideGrant,
  setOutsideGrant,
} from "../../../../../src/main/features/fs/outside-grants";

// The native realpath, as main's: on Windows it also spells out a short name
// in the temp folder's path (RUNNER~1), which the JS one leaves.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-outside-")));
const site = path.join(tmp, "site");
const secret = path.join(tmp, "secret.txt");
fs.mkdirSync(site);
fs.writeFileSync(path.join(site, "index.html"), "<p>hi</p>");
fs.writeFileSync(path.join(site, "style.css"), "p{}");
fs.writeFileSync(secret, "key");
// Only the tests skipped on Windows read the links, and making one there
// takes a privilege a test run may not have.
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

  test.if(process.platform === "win32")(
    "a Windows file is read however its path is written",
    async () => {
      setOutsideGrant("ws", "tab", [], [site.toUpperCase()]);
      const css = path.join(site, "style.css");
      expect(await resolveOutsideGrant("ws", css.replace(/\\/g, "/").toLowerCase())).toBe(css);
    },
  );

  // Making a link on Windows takes a privilege a test run may not have.
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
