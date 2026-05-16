/**
 * GitLoadingSkeleton is the delayed placeholder shown while git status loads.
 * Built from the generic Skeleton/SkeletonLine primitives from ui/skeleton.
 */
import { Skeleton, SkeletonLine } from "../../../ui/skeleton";

export function GitLoadingSkeleton() {
  return (
    <Skeleton label="Loading source control">
      <SkeletonLine className="h-[82px] rounded-[--radius-container] border border-border" />
      <div className="flex flex-col gap-1">
        <SkeletonLine className="h-7" />
        {Array.from({ length: 5 }).map((_, index) => (
          <SkeletonLine
            // Skeleton rows are positional placeholders only.
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton row count.
            key={index}
            className="h-6"
            style={{ opacity: 1 - index * 0.12 }}
          />
        ))}
      </div>
    </Skeleton>
  );
}
