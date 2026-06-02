import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { LspBootstrapProgressPhase } from "../../../shared/lsp/diagnostics";

/**
 * diff-tab.tsx / panel.tsx의 formatBytes와 동일한 구현.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib >= 10 ? 0 : 1)} KB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
}

export interface BootstrapProgressBarProps {
  readonly phase: LspBootstrapProgressPhase;
  readonly name: string;
  readonly bytesDone?: number;
  readonly bytesTotal?: number;
  /**
   * Wrapper classes. The workspace panel pins this to the bottom of the
   * placeholder via absolute positioning; the add-workspace dialog renders it
   * inline. Defaults to an inline column layout.
   */
  readonly className?: string;
}

/**
 * SSH 에이전트 부트스트랩 진행 표시줄 (공유 프레젠테이션 컴포넌트).
 *
 * 정직한 진행률 표시 규칙:
 * - bytesTotal>0 이고 0<bytesDone<bytesTotal 인 경우에만 determinate 바 렌더.
 * - 나머지 모든 경우는 indeterminate(animated) 바 렌더.
 *
 * workspaceId(패널)와 progressId(추가 다이얼로그) 양쪽 진행 이벤트가 같은
 * phase/바이트 필드를 쓰므로 키와 무관하게 이 컴포넌트를 재사용한다.
 */
export function BootstrapProgressBar({
  phase,
  name,
  bytesDone,
  bytesTotal,
  className,
}: BootstrapProgressBarProps): React.JSX.Element {
  const { t } = useTranslation();

  // phase 레이블: 이름이 필요한 phase("uploading", "extracting")에는 name을 보간한다.
  const phaseLabel = t(`panel.bootstrap_phase.${phase}`, { name });

  // 사이즈 문자열: bytesTotal이 있을 때만 표시한다.
  const sizeLabel = bytesTotal && bytesTotal > 0 ? formatBytes(bytesTotal) : undefined;

  // Determinate 여부: bytesDone이 존재하고 0<bytesDone<bytesTotal인 경우에만.
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
          // indeterminate: pulse 애니메이션으로 진행 중임을 표시
          <div className="h-full w-full rounded-full bg-muted-foreground/50 motion-safe:animate-pulse" />
        )}
      </div>
    </div>
  );
}
