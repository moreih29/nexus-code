import { Cpu, MemoryStick } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { SystemStats } from "../../../shared/system/stats";
import {
  cpuLabel,
  drawableStats,
  hostLabel,
  memoryLabel,
  memoryParts,
  memoryPercent,
} from "../../services/system-stats/format";
import { useSystemStats } from "../../services/system-stats/use-system-stats";
import { useActiveStore } from "../../state/stores/active";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { useWorkspacesStore } from "../../state/stores/workspaces";

function useStatsTitle(stats: SystemStats, host: string | null): string {
  const { t } = useTranslation();
  const parts = memoryParts(stats.memUsed, stats.memTotal);
  return [
    host ?? t("systemStats.this_computer"),
    ...(stats.cpu === null ? [] : [t("systemStats.cpu_title", { percent: Math.round(stats.cpu) })]),
    t("systemStats.memory_title", {
      used: parts.used,
      total: parts.total,
      percent: memoryPercent(stats.memUsed, stats.memTotal),
    }),
  ].join("\n");
}

function StatsLine({
  stats,
  host,
  className,
}: {
  stats: SystemStats;
  host: string | null;
  className: string;
}): React.JSX.Element {
  const title = useStatsTitle(stats, host);
  return (
    <div
      className={cn("flex items-center whitespace-nowrap tabular-nums", className)}
      title={title}
      aria-live="off"
    >
      {stats.cpu !== null && (
        <span className="inline-flex items-center gap-1">
          <Cpu className="size-3 shrink-0" aria-hidden="true" />
          <span>{cpuLabel(stats.cpu)}</span>
        </span>
      )}
      <span className="inline-flex min-w-0 items-center gap-1">
        <MemoryStick className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{memoryLabel(stats.memUsed, stats.memTotal)}</span>
      </span>
    </div>
  );
}

export const STATS_MIN_WIDTH = 576;

export function useWiderThan(ref: RefObject<HTMLElement | null>, min: number): boolean {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWide(el.clientWidth >= min);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, min]);
  return wide;
}

export function SystemStatsSegment({
  workspaceId,
}: {
  workspaceId: string;
}): React.JSX.Element | null {
  const isActiveWorkspace = useActiveStore((s) => s.activeWorkspaceId === workspaceId);
  const agentView = useAgentViewStore((s) => s.mode === "agents");
  const stats = useSystemStats(workspaceId, isActiveWorkspace && !agentView);
  const location = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.location,
  );
  if (!stats) return null;
  return <SystemStatsItem stats={stats} host={hostLabel(location)} />;
}

export function SystemStatsItem({
  stats,
  host,
}: {
  stats: SystemStats;
  host: string | null;
}): React.JSX.Element | null {
  const drawn = drawableStats(stats);
  if (!drawn) return null;
  return (
    <StatsLine
      stats={drawn}
      host={host}
      className="h-full gap-2 px-2 text-app-ui-sm font-sans leading-none"
    />
  );
}

export function SystemStatsFooter(): React.JSX.Element | null {
  const read = useSystemStats(undefined, true);
  const stats = read && drawableStats(read);
  if (!stats) return null;
  return (
    <StatsLine
      stats={stats}
      host={null}
      className="shrink-0 gap-3 px-4 py-2.5 text-app-ui-sm text-muted-foreground"
    />
  );
}
