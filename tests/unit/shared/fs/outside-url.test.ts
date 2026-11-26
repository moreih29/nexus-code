import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isDevicePath,
  isNetworkLink,
  isNetworkOrDevicePath,
  windowsPathKind,
} from "../../../../src/shared/fs/outside-url";

const PATH_KINDS: { path: string; kind: string }[] = JSON.parse(
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
