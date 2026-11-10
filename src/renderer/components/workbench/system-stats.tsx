// system-stats.tsx — how busy a machine is: the CPU's share in use and the
// memory, as "23%" and "12.3/32 GB" beside their icons, with whose machine
// and the details in the tooltip. The status bar shows the workspace's host
// (an SSH or WSL one's, from its agent); the agent view's sidebar shows this
// machine. Asked only while shown; nothing renders while the host cannot
// tell (not connected, or an older agent).
//
// The status bar is a live region; the numbers change every few seconds,
// so they are kept out of what it announces.

import { Cpu, MemoryStick } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { SystemStats } from "../../../shared/system/stats";
import {
  cpuLabel,
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
    <div className={cn("flex items-center tabular-nums", className)} title={title} aria-live="off">
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

/** Whether the element is at least `min` px wide, as it resizes. */
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

/**
 * The status bar's item: the workspace's host, asked while its panel is the
 * one shown. Read here, not handed down, so the bar around it does not
 * render again as the view switches.
 */
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
  return (
    <StatsLine
      stats={stats}
      host={hostLabel(location)}
      className="h-full gap-2 px-2 text-app-ui-sm font-sans leading-none"
    />
  );
}

/** The agent view's sidebar foot: this machine. */
export function SystemStatsFooter(): React.JSX.Element | null {
  const stats = useSystemStats(undefined, true);
  if (!stats) return null;
  return (
    <StatsLine
      stats={stats}
      host={null}
      className="shrink-0 gap-3 px-4 py-2.5 text-app-ui-sm text-muted-foreground"
    />
  );
}
