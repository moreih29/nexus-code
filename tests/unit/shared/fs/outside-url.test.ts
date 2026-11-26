import { describe, expect, test } from "bun:test";
import {
  isDevicePath,
  isNetworkLink,
  isNetworkOrDevicePath,
} from "../../../../src/shared/fs/outside-url";

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
    ]) {
      expect([link, isNetworkLink(link)]).toEqual([link, false]);
    }
  });
});

describe("isNetworkOrDevicePath and isDevicePath", () => {
  test("tell shares and devices from local paths", () => {
    expect(isNetworkOrDevicePath("//server/share")).toBe(true);
    expect(isNetworkOrDevicePath("\\\\server\\share")).toBe(true);
    expect(isNetworkOrDevicePath("/tmp/a")).toBe(false);
    expect(isDevicePath("\\\\?\\C:\\a")).toBe(true);
    expect(isDevicePath("//./pipe/x")).toBe(true);
    expect(isDevicePath("\\\\server\\share")).toBe(false);
  });
});
