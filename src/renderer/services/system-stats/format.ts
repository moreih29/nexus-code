import type { SystemStats } from "../../../shared/system/stats";
import type { WorkspaceLocation } from "../../../shared/types/workspace";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

export function drawableStats(stats: SystemStats): SystemStats | null {
  const { cpu, memUsed, memTotal } = stats;
  if (!Number.isFinite(memTotal) || memTotal <= 0) return null;
  return {
    cpu: cpu === null || !Number.isFinite(cpu) ? null : Math.min(100, Math.max(0, cpu)),
    memUsed: Number.isFinite(memUsed) ? Math.min(memTotal, Math.max(0, memUsed)) : memTotal,
    memTotal,
  };
}

export function cpuLabel(cpu: number): string {
  return `${Math.round(cpu)}%`;
}

export function memoryPercent(used: number, total: number): number {
  return total > 0 ? Math.round((100 * used) / total) : 0;
}

function amount(bytes: number, unit: number): string {
  const n = bytes / unit;
  return n < 100 ? n.toFixed(1) : String(Math.round(n));
}

export function memoryLabel(used: number, total: number): string {
  const unit = total >= GIB ? GIB : MIB;
  const name = unit === GIB ? "GB" : "MB";
  const whole = total / unit >= 10 ? String(Math.round(total / unit)) : amount(total, unit);
  return `${amount(used, unit)}/${whole} ${name}`;
}

export function memoryParts(used: number, total: number): { used: string; total: string } {
  const [pair, name] = memoryLabel(used, total).split(" ");
  const [u, t] = pair.split("/");
  return { used: `${u} ${name}`, total: `${t} ${name}` };
}

export function hostLabel(location: WorkspaceLocation | undefined): string | null {
  if (!location || location.kind === "local") return null;
  if (location.kind === "wsl") return location.distro;
  return location.user ? `${location.user}@${location.host}` : location.host;
}
