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

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-outside-")));
const site = path.join(tmp, "site");
const secret = path.join(tmp, "secret.txt");
fs.mkdirSync(site);
fs.writeFileSync(path.join(site, "index.html"), "<p>hi</p>");
fs.writeFileSync(path.join(site, "style.css"), "p{}");
fs.writeFileSync(secret, "key");
fs.symlinkSync(secret, path.join(site, "leak.txt"));
fs.symlinkSync(secret, path.join(tmp, "named-link.txt"));

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

  test("a file granted by name is read where its link points", async () => {
    setOutsideGrant("ws", "tab", [path.join(tmp, "named-link.txt")], []);
    expect(await resolveOutsideGrant("ws", path.join(tmp, "named-link.txt"))).toBe(secret);
  });

  test("a link in a granted folder does not reach out of it", async () => {
    setOutsideGrant("ws", "tab", [], [site]);
    expect(await resolveOutsideGrant("ws", path.join(site, "style.css"))).toBe(
      path.join(site, "style.css"),
    );
    expect(await resolveOutsideGrant("ws", path.join(site, "leak.txt"))).toBeNull();
    expect(await resolveOutsideGrant("ws", path.join(site, "absent.css"))).toBeNull();
    expect(await resolveOutsideGrant("ws", secret)).toBeNull();
  });
});
