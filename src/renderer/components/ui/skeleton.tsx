/**
 * Skeleton — generic animated loading placeholder for any panel surface.
 *
 * The git-specific GitLoadingSkeleton is replaced by this primitive so
 * other panels (search, history, etc.) can use the same pulse pattern
 * without duplicating the animation class.
 */
import { cn } from "@/utils/cn";

interface SkeletonProps {
  /** Accessible label shown to screen readers while content is loading. */
  label?: string;
  className?: string;
  children?: React.ReactNode;
}

/**
 * Wrapper that marks the region as a loading status container.
 */
export function Skeleton({ label = "Loading", className, children }: SkeletonProps) {
  return (
    <div
      className={cn("flex flex-col gap-2 px-2 py-2", className)}
      aria-label={label}
      role="status"
    >
      {children}
    </div>
  );
}

/**
 * Individual skeleton line — an animated pulse block whose height you provide.
 */
export function SkeletonLine({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className={cn("animate-pulse rounded-[--radius-control] bg-muted", className)} style={style} />
  );
}
