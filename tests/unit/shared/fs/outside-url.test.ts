import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import {
  isAutoMountPath,
  isDevicePath,
  isNetworkLink,
  isNetworkOrDevicePath,
  windowsPathKind,
} from "../../../../src/shared/fs/outside-url";

const PATH_KINDS: { path: string; kind: string; cleaned?: string }[] = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../fixtures/windows-path-kinds.json"), "utf8"),
);

describe("windowsPathKind", () => {
  test("the shared table has every kind", () => {
    expect(new Set(PATH_KINDS.map(({ kind }) => kind))).toEqual(
      new Set(["device", "unc", "drive", "rooted", "relative"]),
    );
  });

  test.each(PATH_KINDS.map(({ path, kind }) => [path, kind]))("%p is %s", (path, kind) => {
    expect(windowsPathKind(path)).toBe(kind);
    expect(isNetworkOrDevicePath(path)).toBe(kind === "unc" || kind === "device");
    expect(isDevicePath(path)).toBe(kind === "device");
  });

  test("the table holds rooted paths that a POSIX clean turns into a share or a device", () => {
    const cleaned = PATH_KINDS.filter((row) => row.cleaned !== undefined);
    expect(cleaned.length).toBeGreaterThan(0);
    for (const { path, cleaned: kind } of cleaned) {
      expect([path, windowsPathKind(posix.normalize(path))]).toEqual([path, kind]);
    }
  });
});

describe("isNetworkLink", () => {
  test("a share, a device or a file URL with a host is a network link", () => {
    for (const link of [
      "\\\\server\\share\\a.png",
      "\\\\server/share/a.png",
      "//server/share/a.png",
      "/\\server\\share\\a.png",
      "\\\\?\\C:\\a.png",
      "\\\\.\\pipe\\x",
      "//?/C:/a.png",
      " \\\\server\\share ",
      "file://server/share/a.png",
      "file:////server/share/a.png",
      "FILE://Server/share",
      "file:\\\\\\\\server\\share\\a.png",
      "%5C%5Cserver%5Cshare%5Ca.txt",
      "%2F%2Fserver/share",
      String.raw`\??\UNC\server\share\a.txt`,
      "/??/UNC/server/share/a.txt",
      String.raw`\??\C:\a.txt`,
      "/%3F%3F/UNC/server/share/a.txt",
      "%5C%3F%3F%5CUNC%5Cserver%5Cshare%5Ca.txt",
      "file:///%3F%3F/UNC/server/share/a.txt",
      "file://localhost/??/UNC/server/share/a.txt",
      String.raw`file:\\\??\UNC\server\share`,
      "file://localhost//server/share/a.txt",
      "FILE://LOCALHOST//server/share/a.txt",
      String.raw`file://localhost/\server\share\a.txt`,
      "file://localhost%2F%2Fserver/share/a.txt",
      "file://///server/share/a.txt",
    ]) {
      expect([link, isNetworkLink(link)]).toEqual([link, true]);
    }
  });

  test("a path on this computer is not", () => {
    for (const link of [
      "/tmp/a.png",
      "C:\\a.png",
      "C:/a.png",
      "out/a.png",
      "./a.png",
      "file:///tmp/a.png",
      "file:///C:/a.png",
      "file://localhost/tmp/a.png",
      "https://example.test/a.png",
      "/tmp/a%20b.png",
      "/tmp/100%.png",
      "/??a/b.png",
      "file:///tmp/??.png",
    ]) {
      expect([link, isNetworkLink(link)]).toEqual([link, false]);
    }
  });
});

describe("isNetworkOrDevicePath and isDevicePath", () => {
  test.each([
    [String.raw`\\server\share`, true, false],
    ["//server/share", true, false],
    [String.raw`/\server/share`, true, false],
    [String.raw`\//server\share`, true, false],
    [String.raw`\\?\C:\a`, true, true],
    [String.raw`\\?\UNC\server\share`, true, true],
    [String.raw`\\.\C:\a`, true, true],
    [String.raw`/\?/UNC/server/share`, true, true],
    ["//./pipe/x", true, true],
    [String.raw`C:\a`, false, false],
    ["D:/a", false, false],
    ["/tmp/a", false, false],
    ["relative/a", false, false],
  ])("classifies %s", (path, network, device) => {
    expect(isNetworkOrDevicePath(path)).toBe(network);
    expect(isDevicePath(path)).toBe(device);
  });
});

describe("isAutoMountPath", () => {
  test.each([
    "/net/host/share/a.txt",
    "/net",
    "/NET/host/a.txt",
    "/Network/Servers/host/a.txt",
    "/network/servers/a.txt",
    "//net/host/a.txt",
    "/./net/host/a.txt",
    "/tmp/../net/host/a.txt",
    "/System/Volumes/Data/net/host/a.txt",
    "/System/Volumes/Data/Network/Servers/a.txt",
  ])("%s is an automount path", (path) => {
    expect(isAutoMountPath(path)).toBe(true);
  });

  test.each([
    "/tmp/net/a.txt",
    "/network-notes/a.txt",
    "/netbox/a.txt",
    "/Users/me/Network/a.txt",
    "net/host/a.txt",
    "C:/net/a.txt",
    "/System/Volumes/net/a.txt",
  ])("%s is not", (path) => {
    expect(isAutoMountPath(path)).toBe(false);
  });
});
