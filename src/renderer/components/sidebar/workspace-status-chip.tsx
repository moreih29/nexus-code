import { CircleAlert, CircleCheck, CircleDot, Loader, TriangleAlert } from "lucide-react";
import { cn } from "@/utils/cn";
import type { ClaudeStatus } from "../../../shared/claude/status";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface WorkspaceStatusChipProps {
  /** 표시할 Claude 세션 집계 상태. idle이면 null을 반환한다. */
  status: ClaudeStatus;
  /** attention 탭 수. 2 이상이면 글리프 옆에 숫자를 표시한다. */
  count?: number;
  /**
   * 컴팩트 모드 — 사이드바 폭이 좁을 때 레이블을 숨기고 글리프만 표시한다.
   * aria-label은 항상 유지된다.
   */
  compact?: boolean;
}

// ---------------------------------------------------------------------------
// 상태 매트릭스
// ---------------------------------------------------------------------------

/**
 * 상태별 글리프, 레이블, 색 토큰 매핑.
 *
 * 칩 fg/bg는 CSS 변수 참조로만 지정한다. 임의 hex 값 사용 금지.
 *
 * | 상태             | 레이블     | 칩 fg 토큰                   | 칩 bg 토큰                        |
 * |------------------|------------|------------------------------|-----------------------------------|
 * | running          | Running    | --state-loading-indicator    | 같은 색 /[0.10]                   |
 * | completed        | Done       | --tab-claude-attention-fg    | 같은 색 /[0.10]                   |
 * | needsInput       | Input      | --tab-claude-attention-fg    | 같은 색 /[0.10]                   |
 * | permissionPending| Permission | --state-warning-fg           | --state-warning-bg/[0.12]         |
 * | error            | Error      | --state-error-fg             | --state-error-bg/[0.12]           |
 */

interface StatusChipConfig {
  label: string;
  ariaLabel: string;
  /** Tailwind 클래스로 표현하는 칩 text 색 */
  fgClass: string;
  /** Tailwind 클래스로 표현하는 칩 배경 색 */
  bgClass: string;
  glyph: React.ReactNode;
}

function getChipConfig(status: ClaudeStatus): StatusChipConfig | null {
  switch (status) {
    case "running":
      return {
        label: "Running",
        ariaLabel: "Claude: running",
        fgClass: "text-(--state-loading-indicator)",
        bgClass: "bg-(--state-loading-indicator)/[0.10]",
        glyph: (
          <Loader
            width={10}
            height={10}
            strokeWidth={1.5}
            aria-hidden
            className="shrink-0 motion-safe:animate-spin"
          />
        ),
      };
    case "completed":
      return {
        label: "Done",
        ariaLabel: "Claude: response complete",
        fgClass: "text-(--tab-claude-attention-fg)",
        bgClass: "bg-(--tab-claude-attention-fg)/[0.10]",
        glyph: (
          <CircleCheck
            width={10}
            height={10}
            strokeWidth={1.5}
            aria-hidden
            className="shrink-0"
          />
        ),
      };
    case "needsInput":
      return {
        label: "Input",
        ariaLabel: "Claude: waiting for input",
        fgClass: "text-(--tab-claude-attention-fg)",
        bgClass: "bg-(--tab-claude-attention-fg)/[0.12]",
        glyph: (
          <CircleDot
            width={10}
            height={10}
            strokeWidth={1.5}
            aria-hidden
            className="shrink-0"
          />
        ),
      };
    case "permissionPending":
      return {
        label: "Permission",
        ariaLabel: "Claude: waiting for permission",
        fgClass: "text-(--state-warning-fg)",
        bgClass: "bg-(--state-warning-bg)/[0.12]",
        glyph: (
          <CircleAlert
            width={10}
            height={10}
            strokeWidth={1.5}
            aria-hidden
            className="shrink-0"
          />
        ),
      };
    case "error":
      return {
        label: "Error",
        ariaLabel: "Claude: error",
        fgClass: "text-(--state-error-fg)",
        bgClass: "bg-(--state-error-bg)/[0.12]",
        glyph: (
          <TriangleAlert
            width={10}
            height={10}
            strokeWidth={1.5}
            aria-hidden
            className="shrink-0"
          />
        ),
      };
    case "idle":
      // idle 상태는 칩 미렌더 — 호출자가 조건부로 렌더해야 한다.
      return null;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * 워크스페이스 카드 1줄 우측 인라인 상태 칩.
 *
 * - idle 상태이면 null을 반환한다 (칩 없음).
 * - compact=true이면 레이블을 숨기고 글리프만 표시한다 (aria-label은 유지).
 * - count >= 2이면 레이블 대신 숫자를 표시한다.
 */
export function WorkspaceStatusChip({ status, count, compact = false }: WorkspaceStatusChipProps) {
  const config = getChipConfig(status);
  if (!config) return null;

  // count >= 2 이면 숫자를 표시. compact이면 레이블/숫자 모두 숨긴다.
  const displayLabel = !compact ? (count !== undefined && count >= 2 ? String(count) : config.label) : null;

  return (
    <span
      role="status"
      aria-label={config.ariaLabel}
      className={cn(
        "inline-flex items-center gap-1 px-1.5 h-5 rounded-(--radius-control)",
        "text-app-micro shrink-0",
        config.fgClass,
        config.bgClass,
      )}
    >
      {config.glyph}
      {displayLabel !== null && (
        <span aria-hidden>{displayLabel}</span>
      )}
    </span>
  );
}
