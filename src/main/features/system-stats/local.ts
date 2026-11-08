/**
 * This machine's numbers. The CPU's share is over the span since the last
 * ask; the first ask, or one after a long quiet, measures a short span of
 * its own so it does not answer with an average over minutes.
 */
import { execFile } from "node:child_process";
import os from "node:os";
import type { SystemStats } from "../../../shared/system/stats";
import { busyShare, type CpuTimes, cpuTimesOf, vmStatUsed } from "./parse";

/** An older reading starts a new span instead. */
const STALE_MS = 10_000;
/** How long a new span runs before its first answer. */
const FIRST_SPAN_MS = 250;

export interface LocalHost {
  cpus(): CpuTimes;
  totalmem(): number;
  freemem(): number;
  /** macOS's vm_stat output; null elsewhere or when it fails. */
  vmStat(): Promise<string | null>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

function runVmStat(): Promise<string | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("/usr/bin/vm_stat", { timeout: 2_000 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

export const machineHost: LocalHost = {
  cpus: () => cpuTimesOf(os.cpus()),
  totalmem: () => os.totalmem(),
  freemem: () => os.freemem(),
  vmStat: runVmStat,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class LocalStats {
  private last: { times: CpuTimes; at: number } | null = null;
  private lastShare: number | null = null;
  private reading: Promise<SystemStats> | null = null;
  private readonly host: LocalHost;

  constructor(host: LocalHost = machineHost) {
    this.host = host;
  }

  /** The numbers now; asks that overlap share one reading. */
  read(): Promise<SystemStats> {
    this.reading ??= this.measure().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  private async measure(): Promise<SystemStats> {
    const [cpu, memory] = await Promise.all([this.cpu(), this.memory()]);
    return { cpu, ...memory };
  }

  private async cpu(): Promise<number | null> {
    if (!this.last || this.host.now() - this.last.at > STALE_MS) {
      this.last = { times: this.host.cpus(), at: this.host.now() };
      await this.host.sleep(FIRST_SPAN_MS);
    }
    const next = this.host.cpus();
    const share = busyShare(this.last.times, next);
    // Asked again before any time passed: the last answer stands.
    if (share === null) return this.lastShare;
    this.last = { times: next, at: this.host.now() };
    this.lastShare = share;
    return share;
  }

  private async memory(): Promise<{ memUsed: number; memTotal: number }> {
    const memTotal = this.host.totalmem();
    const vmStat = await this.host.vmStat();
    const fromVmStat = vmStat === null ? null : vmStatUsed(vmStat);
    // Linux's free memory is what is available (libuv reads MemAvailable),
    // Windows' the available physical memory.
    const memUsed = fromVmStat ?? memTotal - this.host.freemem();
    return { memUsed: Math.min(Math.max(memUsed, 0), memTotal), memTotal };
  }
}
