/**
 * The numbers as the status bar and the agent view's sidebar write them:
 * "23%" and "12.3/32 GB", and whose machine they are. Pure, for tests.
 */
import type { WorkspaceLocation } from "../../../shared/types/workspace";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** The CPU's share, whole: "23%". */
export function cpuLabel(cpu: number): string {
  return `${Math.round(cpu)}%`;
}

/** The share of the memory in use, whole. */
export function memoryPercent(used: number, total: number): number {
  return total > 0 ? Math.round((100 * used) / total) : 0;
}

/** One amount in the unit `unit` is: tenths under 100, whole above. */
function amount(bytes: number, unit: number): string {
  const n = bytes / unit;
  return n < 100 ? n.toFixed(1) : String(Math.round(n));
}

/**
 * The memory in use of all there is: "12.3/32 GB". The whole of it is
 * written as the machine is sold, whole from 10 GB; under 1 GB, in MB.
 */
export function memoryLabel(used: number, total: number): string {
  const unit = total >= GIB ? GIB : MIB;
  const name = unit === GIB ? "GB" : "MB";
  const whole = total / unit >= 10 ? String(Math.round(total / unit)) : amount(total, unit);
  return `${amount(used, unit)}/${whole} ${name}`;
}

/** Each part of the memory label, for the tooltip: "12.3 GB" and "32 GB". */
export function memoryParts(used: number, total: number): { used: string; total: string } {
  const [pair, name] = memoryLabel(used, total).split(" ");
  const [u, t] = pair.split("/");
  return { used: `${u} ${name}`, total: `${t} ${name}` };
}

/** Whose machine the numbers are: the SSH host, the WSL distribution, or null for this one. */
export function hostLabel(location: WorkspaceLocation | undefined): string | null {
  if (!location || location.kind === "local") return null;
  if (location.kind === "wsl") return location.distro;
  return location.user ? `${location.user}@${location.host}` : location.host;
}
