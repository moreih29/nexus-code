import { describe, expect, test } from "bun:test";
import { supportsWindowsBackdrop } from "../../../../../src/main/infra/platform/windows-backdrop";

describe("supportsWindowsBackdrop", () => {
  test("is on from Windows 11 22H2", () => {
    expect(supportsWindowsBackdrop("win32", "10.0.22621")).toBe(true);
    expect(supportsWindowsBackdrop("win32", "10.0.26100")).toBe(true);
    expect(supportsWindowsBackdrop("win32", "10.0.26200")).toBe(true);
  });

  test("is off on Windows 11 21H2 and Windows 10", () => {
    expect(supportsWindowsBackdrop("win32", "10.0.22000")).toBe(false);
    expect(supportsWindowsBackdrop("win32", "10.0.19045")).toBe(false);
  });

  test("is off when the release does not parse", () => {
    expect(supportsWindowsBackdrop("win32", "")).toBe(false);
    expect(supportsWindowsBackdrop("win32", "10.0")).toBe(false);
  });

  test("is off on other platforms", () => {
    expect(supportsWindowsBackdrop("darwin", "24.0.0")).toBe(false);
    expect(supportsWindowsBackdrop("linux", "6.8.0-generic")).toBe(false);
  });
});
