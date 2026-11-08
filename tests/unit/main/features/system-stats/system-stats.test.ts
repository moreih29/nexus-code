import { describe, expect, test } from "bun:test";
import { systemStats } from "../../../../../src/main/features/system-stats";
import { type LocalHost, LocalStats } from "../../../../../src/main/features/system-stats/local";
import {
  busyShare,
  cpuTimesOf,
  vmStatUsed,
} from "../../../../../src/main/features/system-stats/parse";

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    70691.
Pages active:                                 635175.
Pages wired down:                             302926.
Pages purgeable:                                6612.
"Translation faults":                    42756437943.
Anonymous pages:                              842413.
Pages occupied by compressor:                 402821.
`;

describe("reading the numbers", () => {
  test("vm_stat: the programs' pages less purgeable, wired and compressed", () => {
    expect(vmStatUsed(VM_STAT)).toBe((842413 - 6612 + 302926 + 402821) * 16384);
    expect(vmStatUsed("Pages free: 1.\n")).toBeNull();
    expect(vmStatUsed(VM_STAT.replace(/Anonymous pages.*\n/, ""))).toBeNull();
  });

  test("the CPU's share between two readings", () => {
    const cpu = (user: number, idle: number) => ({
      times: { user, nice: 0, sys: 0, idle, irq: 0 },
    });
    const prev = cpuTimesOf([cpu(100, 900), cpu(100, 900)]);
    const next = cpuTimesOf([cpu(200, 1000), cpu(150, 950)]);
    expect(prev).toEqual({ total: 2000, idle: 1800 });
    expect(busyShare(prev, next)).toBe(50);
    expect(busyShare(next, next)).toBeNull();
  });
});

function fakeHost(readings: { total: number; idle: number }[]): LocalHost & {
  clock: number;
  slept: number;
} {
  let read = 0;
  const host = {
    clock: 1_000_000,
    slept: 0,
    cpus: () => readings[read++],
    totalmem: () => 8_000,
    freemem: () => 3_000,
    vmStat: async () => null,
    now: () => host.clock,
    sleep: async (ms: number) => {
      host.slept++;
      host.clock += ms;
    },
  };
  return host;
}

describe("this machine", () => {
  test("a first ask measures a span; the next answers since the last", async () => {
    const host = fakeHost([
      { total: 1000, idle: 900 },
      { total: 1100, idle: 950 },
      { total: 1300, idle: 1100 },
      { total: 1300, idle: 1100 },
      { total: 5000, idle: 4000 },
      { total: 5100, idle: 4090 },
    ]);
    const local = new LocalStats(host);
    expect(await local.read()).toEqual({ cpu: 50, memUsed: 5_000, memTotal: 8_000 });
    host.clock += 3_000;
    expect((await local.read()).cpu).toBe(25);
    // No time passed: the last answer stands.
    expect((await local.read()).cpu).toBe(25);
    // A long quiet starts a new span.
    host.clock += 60_000;
    expect((await local.read()).cpu).toBeCloseTo(10);
    expect(host.slept).toBe(2);
  });

  test("asks that overlap share one reading", async () => {
    const host = fakeHost([
      { total: 1000, idle: 900 },
      { total: 1100, idle: 950 },
    ]);
    const local = new LocalStats(host);
    const [a, b] = await Promise.all([local.read(), local.read()]);
    expect(a).toBe(b);
    expect(host.slept).toBe(1);
  });

  test("on macOS the memory in use is vm_stat's", async () => {
    const host = fakeHost([
      { total: 1000, idle: 900 },
      { total: 1100, idle: 950 },
    ]);
    host.totalmem = () => 34_359_738_368;
    host.vmStat = async () => VM_STAT;
    const stats = await new LocalStats(host).read();
    expect(stats.memUsed).toBe((842413 - 6612 + 302926 + 402821) * 16384);
  });
});

describe("system.stats", () => {
  const local = { read: async () => ({ cpu: 1, memUsed: 2, memTotal: 3 }) } as LocalStats;
  const sources = (remote: (id: string) => Promise<unknown | null>) => ({
    local,
    isLocal: (id: string) => id === "here",
    exists: (id: string) => id === "here" || id === "ssh",
    remote,
  });
  const fromAgent = { cpu: 12.5, memUsed: 1024, memTotal: 4096 };

  test("this machine when none is named or it is local; the agent's otherwise", async () => {
    const asked: string[] = [];
    const s = sources(async (id) => {
      asked.push(id);
      return fromAgent;
    });
    expect(await systemStats(s, undefined)).toEqual({ cpu: 1, memUsed: 2, memTotal: 3 });
    expect(await systemStats(s, "here")).toEqual({ cpu: 1, memUsed: 2, memTotal: 3 });
    expect(await systemStats(s, "ssh")).toEqual(fromAgent);
    expect(asked).toEqual(["ssh"]);
  });

  test("none while the host cannot tell", async () => {
    expect(
      await systemStats(
        sources(async () => null),
        "ssh",
      ),
    ).toBeNull();
    // An agent from before system.stats.
    const old = sources(async () => {
      throw new Error("unknown method: system.stats");
    });
    expect(await systemStats(old, "ssh")).toBeNull();
    expect(
      await systemStats(
        sources(async () => ({ cpu: 5 })),
        "ssh",
      ),
    ).toBeNull();
    expect(
      await systemStats(
        sources(async () => fromAgent),
        "gone",
      ),
    ).toBeNull();
    // The agent's CPU share may be unknown.
    const noCpu = { ...fromAgent, cpu: null };
    expect(
      await systemStats(
        sources(async () => noCpu),
        "ssh",
      ),
    ).toEqual(noCpu);
  });
});
