import { describe, expect, test } from "bun:test";
import {
  fromUriPath,
  isDrivePath,
  toNativeDrivePath,
  toSlashPath,
  toUriPath,
} from "../../../src/shared/fs/drive-path";

describe("drive path helpers", () => {
  test("recognizes drive paths only", () => {
    expect(isDrivePath("C:\\work")).toBe(true);
    expect(isDrivePath("c:/work")).toBe(true);
    expect(isDrivePath("C:")).toBe(true);
    expect(isDrivePath("/work")).toBe(false);
    expect(isDrivePath("work/C:")).toBe(false);
    expect(isDrivePath("C:work")).toBe(false);
  });

  test("converts drive paths to slashes with an upper-case drive", () => {
    expect(toSlashPath("c:\\work\\demo")).toBe("C:/work/demo");
    expect(toSlashPath("C:\\work\\demo/crlf.txt")).toBe("C:/work/demo/crlf.txt");
  });

  test("leaves POSIX paths alone, backslashes included", () => {
    expect(toSlashPath("/home/me/a\\b")).toBe("/home/me/a\\b");
    expect(toNativeDrivePath("/home/me/a")).toBe("/home/me/a");
  });

  test("shows drive paths with backslashes", () => {
    expect(toNativeDrivePath("C:/work/demo")).toBe("C:\\work\\demo");
  });

  test("moves the drive in and out of URI paths", () => {
    expect(toUriPath("C:/work/demo")).toBe("/c:/work/demo");
    expect(fromUriPath("/c:/work/demo")).toBe("C:/work/demo");
    expect(fromUriPath("/C:")).toBe("C:");
    expect(toUriPath("/home/me")).toBe("/home/me");
    expect(fromUriPath("/home/me")).toBe("/home/me");
  });
});
