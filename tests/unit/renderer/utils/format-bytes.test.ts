/**
 * formatBytes: a byte count as people read it, the unit picked after
 * rounding, so a size just under a unit reads as one of it.
 */
import { describe, expect, test } from "bun:test";
import { formatBytes } from "../../../../src/renderer/utils/format-bytes";

describe("formatBytes", () => {
  test("bytes, then KB and MB, to one decimal under 10", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(3_500)).toBe("3.4 KB");
    expect(formatBytes(87 * 1024 * 1024)).toBe("87 MB");
    expect(formatBytes(2.25 * 1024 * 1024)).toBe("2.3 MB");
  });

  test("a size just under a unit reads as one of it", () => {
    expect(formatBytes(1_048_575)).toBe("1.0 MB");
    expect(formatBytes(1_048_064)).toBe("1.0 MB");
    expect(formatBytes(10_235)).toBe("10 KB");
  });
});

describe("notes storage sizes", () => {
  test("preserves raw unit thresholds and one decimal in MB and GB", () => {
    expect(formatBytes(512, "notes")).toBe("512 B");
    expect(formatBytes(10_235, "notes")).toBe("10.0 KB");
    expect(formatBytes(10_240, "notes")).toBe("10 KB");
    expect(formatBytes(1_048_575, "notes")).toBe("1024 KB");
    expect(formatBytes(87 * 1024 ** 2, "notes")).toBe("87.0 MB");
    expect(formatBytes(1024 ** 3, "notes")).toBe("1.0 GB");
  });
});
