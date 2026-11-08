import { describe, expect, test } from "bun:test";
import {
  cpuLabel,
  hostLabel,
  memoryLabel,
  memoryParts,
  memoryPercent,
} from "../../../../../src/renderer/services/system-stats/format";

const GIB = 1024 ** 3;

describe("system stats as written", () => {
  test("the CPU's share, whole", () => {
    expect(cpuLabel(23.4)).toBe("23%");
    expect(cpuLabel(99.6)).toBe("100%");
    expect(cpuLabel(0)).toBe("0%");
  });

  test("memory: tenths in use, the whole as sold", () => {
    expect(memoryLabel(12.34 * GIB, 32 * GIB)).toBe("12.3/32 GB");
    // Linux reports a little under what is fitted.
    expect(memoryLabel(3.1 * GIB, 15.6 * GIB)).toBe("3.1/16 GB");
    expect(memoryLabel(3.14 * GIB, 7.7 * GIB)).toBe("3.1/7.7 GB");
    expect(memoryLabel(120 * GIB, 256 * GIB)).toBe("120/256 GB");
    expect(memoryLabel(300 * 1024 ** 2, 512 * 1024 ** 2)).toBe("300/512 MB");
    expect(memoryParts(12.34 * GIB, 32 * GIB)).toEqual({ used: "12.3 GB", total: "32 GB" });
    expect(memoryPercent(12 * GIB, 32 * GIB)).toBe(38);
    expect(memoryPercent(1, 0)).toBe(0);
  });

  test("whose machine: the SSH host, the WSL distribution, or none for this one", () => {
    expect(hostLabel(undefined)).toBeNull();
    expect(hostLabel({ kind: "local", rootPath: "/w" } as never)).toBeNull();
    expect(hostLabel({ kind: "ssh", host: "nxq-cc", user: "qa", remotePath: "/p" })).toBe(
      "qa@nxq-cc",
    );
    expect(hostLabel({ kind: "ssh", host: "box", remotePath: "/p" })).toBe("box");
    expect(hostLabel({ kind: "wsl", distro: "Ubuntu", remotePath: "/p" })).toBe("Ubuntu");
  });
});
