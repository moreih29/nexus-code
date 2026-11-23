import { cn } from "@/utils/cn";

interface SkeletonProps {
  label?: string;
  className?: string;
  children?: React.ReactNode;
}

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

export function SkeletonLine({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={cn("animate-pulse rounded-(--radius-control) bg-muted", className)}
      style={style}
    />
  );
}
