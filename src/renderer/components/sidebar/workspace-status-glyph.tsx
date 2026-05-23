import {
  CircleAlert,
  CircleCheck,
  Loader,
  MessageCircleQuestion,
  TriangleAlert,
} from "lucide-react";
import type React from "react";
import { cn } from "@/utils/cn";
import type { ClaudeStatus } from "../../../shared/claude/status";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface WorkspaceStatusGlyphProps {
  /** 표시할 Claude 세션 집계 상태. */
  status: ClaudeStatus;
}

// ---------------------------------------------------------------------------
// 상태 매트릭스
// ---------------------------------------------------------------------------

/**
 * 상태별 글리프·색 매핑.
 *
 * 사이드바 워크스페이스 카드의 메시지 줄 인라인에 표시되는 작은 인디케이터.
 * 레이블·배경 없이 글리프만 렌더한다(시각 노이즈 최소화).
 *
 * | 상태             | 글리프                | 색 토큰                      | 비고                          |
 * |------------------|-----------------------|------------------------------|-------------------------------|
 * | idle             | (없음)                | —                            | 글리프 자체 미렌더            |
 * | running          | Loader (spin)         | text-emerald-500             | 동작 중                       |
 * | completed        | CircleCheck           | --tab-claude-attention-fg    | 응답 종료(미확인)             |
 * | needsInput       | MessageCircleQuestion | --tab-claude-attention-fg    | 입력 필요 — pulse 애니메이션  |
 * | permissionPending| CircleAlert           | --state-warning-fg           | 권한 승인 필요                |
 * | error            | TriangleAlert         | --state-error-fg             | 에러                          |
 *
 * idle은 시각 노이즈 줄이기 위해 글리프를 그리지 않는다. running 초록·completed
 * 파랑은 사용자 직접 지정. needsInput은 completed와 같은 색이지만 pulse로 구분.
 */

interface GlyphConfig {
  ariaLabel: string;
  /** Tailwind 클래스로 표현하는 글리프 색 */
  colorClass: string;
  Icon: React.ComponentType<{
    width?: number;
    height?: number;
    strokeWidth?: number;
    "aria-hidden"?: boolean;
    className?: string;
  }>;
  spin?: boolean;
  /** attention을 끌기 위한 pulse 애니메이션 적용 여부 */
  pulse?: boolean;
}

function getGlyphConfig(status: Exclude<ClaudeStatus, "idle">): GlyphConfig {
  switch (status) {
    case "running":
      return {
        ariaLabel: "Claude: running",
        colorClass: "text-emerald-500",
        Icon: Loader,
        spin: true,
      };
    case "completed":
      return {
        ariaLabel: "Claude: response complete",
        colorClass: "text-(--tab-claude-attention-fg)",
        Icon: CircleCheck,
      };
    case "needsInput":
      return {
        ariaLabel: "Claude: waiting for input",
        colorClass: "text-(--tab-claude-attention-fg)",
        Icon: MessageCircleQuestion,
        pulse: true,
      };
    case "permissionPending":
      return {
        ariaLabel: "Claude: waiting for permission",
        colorClass: "text-(--state-warning-fg)",
        Icon: CircleAlert,
      };
    case "error":
      return {
        ariaLabel: "Claude: error",
        colorClass: "text-(--state-error-fg)",
        Icon: TriangleAlert,
      };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * 워크스페이스 카드의 작은 상태 글리프.
 *
 * 메시지 줄 인라인에 12px 글리프로 렌더한다. idle 상태는 글리프 자체를 그리지
 * 않는다(null 반환). 배경·패딩·레이블 없이 색과 형태로만 상태를 전달한다.
 */
export function WorkspaceStatusGlyph({ status }: WorkspaceStatusGlyphProps) {
  if (status === "idle") return null;
  const { ariaLabel, colorClass, Icon, spin, pulse } = getGlyphConfig(status);

  return (
    <span
      role="status"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex shrink-0",
        colorClass,
        pulse && "motion-safe:animate-pulse",
      )}
    >
      <Icon
        width={12}
        height={12}
        strokeWidth={1.5}
        aria-hidden
        className={cn("shrink-0", spin && "motion-safe:animate-spin")}
      />
    </span>
  );
}
