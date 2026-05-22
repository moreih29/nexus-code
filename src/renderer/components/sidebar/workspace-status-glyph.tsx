import { CircleAlert, CircleCheck, CircleDot, Loader, TriangleAlert } from "lucide-react";
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
 * 사이드바 워크스페이스 카드의 ssh/local 아이콘 아래에 표시되는 작은 인디케이터.
 * 레이블·배경 없이 글리프만 렌더한다(시각 노이즈 최소화).
 *
 * | 상태             | 글리프         | 색 토큰                      | 비고                 |
 * |------------------|----------------|------------------------------|----------------------|
 * | idle             | CircleCheck    | text-muted-foreground        | 사용자 확인 완료 dim |
 * | running          | Loader (spin)  | text-emerald-500             | 동작 중              |
 * | completed        | CircleCheck    | --tab-claude-attention-fg    | 응답 종료(미확인)    |
 * | needsInput       | CircleDot      | --tab-claude-attention-fg    | 입력 필요            |
 * | permissionPending| CircleAlert    | --state-warning-fg           | 권한 승인 필요       |
 * | error            | TriangleAlert  | --state-error-fg             | 에러                 |
 *
 * running 초록·idle 회색·completed 파랑은 사용자 직접 지정.
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
}

function getGlyphConfig(status: ClaudeStatus): GlyphConfig {
  switch (status) {
    case "idle":
      return {
        ariaLabel: "Claude: idle",
        colorClass: "text-muted-foreground",
        Icon: CircleCheck,
      };
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
        Icon: CircleDot,
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
 * ssh/local 아이콘(16px) 셀 아래에 12px 글리프로 렌더한다.
 * 배경·패딩·레이블 없이 색과 형태로만 상태를 전달한다.
 */
export function WorkspaceStatusGlyph({ status }: WorkspaceStatusGlyphProps) {
  const { ariaLabel, colorClass, Icon, spin } = getGlyphConfig(status);

  return (
    <span
      role="status"
      aria-label={ariaLabel}
      className={cn("inline-flex shrink-0", colorClass)}
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
