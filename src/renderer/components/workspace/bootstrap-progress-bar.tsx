import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { formatBytes } from "@/utils/format-bytes";
import type { LspBootstrapProgressPhase } from "../../../shared/lsp/diagnostics";

export interface BootstrapProgressBarProps {
  readonly phase: LspBootstrapProgressPhase;
  readonly name: string;
  readonly bytesDone?: number;
  readonly bytesTotal?: number;
  readonly className?: string;
}

export function BootstrapProgressBar({
  phase,
  name,
  bytesDone,
  bytesTotal,
  className,
}: BootstrapProgressBarProps): React.JSX.Element {
  const { t } = useTranslation();

  const phaseLabel = t(`panel.bootstrap_phase.${phase}`, { name });

  const sizeLabel = bytesTotal && bytesTotal > 0 ? formatBytes(bytesTotal) : undefined;

  const isDeterminate =
    bytesTotal !== undefined &&
    bytesTotal > 0 &&
    bytesDone !== undefined &&
    bytesDone > 0 &&
    bytesDone < bytesTotal;
  const percent = isDeterminate ? Math.round((bytesDone / bytesTotal) * 100) : undefined;

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-baseline justify-between gap-2 text-app-micro text-muted-foreground">
        <span className="truncate">{phaseLabel}</span>
        {sizeLabel && <span className="shrink-0 tabular-nums">{sizeLabel}</span>}
      </div>
      <div
        role="progressbar"
        aria-label={phaseLabel}
        aria-valuenow={percent}
        aria-valuemin={isDeterminate ? 0 : undefined}
        aria-valuemax={isDeterminate ? 100 : undefined}
        className="h-1 w-full overflow-hidden rounded-full bg-muted"
      >
        {isDeterminate ? (
          <div
            className="h-full rounded-full bg-muted-foreground/50 transition-[width]"
            style={{ width: `${percent}%` }}
          />
        ) : (
          <div className="h-full w-full rounded-full bg-muted-foreground/50 motion-safe:animate-pulse" />
        )}
      </div>
    </div>
  );
}
