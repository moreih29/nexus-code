export interface CpuTimes {
  total: number;
  idle: number;
}

export function cpuTimesOf(
  cpus: readonly {
    times: { user: number; nice: number; sys: number; idle: number; irq: number };
  }[],
): CpuTimes {
  let total = 0;
  let idle = 0;
  for (const { times } of cpus) {
    total += times.user + times.nice + times.sys + times.idle + times.irq;
    idle += times.idle;
  }
  return { total, idle };
}

export function busyShare(prev: CpuTimes, next: CpuTimes): number | null {
  const total = next.total - prev.total;
  const idle = next.idle - prev.idle;
  if (total <= 0 || idle < 0) return null;
  return Math.min(100, Math.max(0, (100 * (total - idle)) / total));
}

export function vmStatUsed(text: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(text)?.[1];
  if (!pageSize) return null;
  const pages = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^"?([^":]+)"?:\s+(\d+)\.?\s*$/.exec(line);
    if (match) pages.set(match[1], Number(match[2]));
  }
  const anonymous = pages.get("Anonymous pages");
  const wired = pages.get("Pages wired down");
  const compressor = pages.get("Pages occupied by compressor");
  if (anonymous === undefined || wired === undefined || compressor === undefined) return null;
  const purgeable = Math.min(pages.get("Pages purgeable") ?? 0, anonymous);
  return (anonymous - purgeable + wired + compressor) * Number(pageSize);
}
