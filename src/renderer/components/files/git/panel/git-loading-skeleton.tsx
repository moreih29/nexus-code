/**
 * GitLoadingSkeleton is the delayed placeholder shown while git status loads.
 */
export function GitLoadingSkeleton() {
  return (
    <div
      className="flex flex-col gap-3 px-2 py-2"
      aria-label="Loading source control"
      role="status"
    >
      <div className="h-[82px] animate-pulse rounded-[--radius-container] border border-border bg-muted" />
      <div className="flex flex-col gap-1">
        <div className="h-7 animate-pulse rounded bg-muted" />
        {Array.from({ length: 5 }).map((_, index) => (
          <div
            // Skeleton rows are positional placeholders only.
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton row count.
            key={index}
            className="h-6 animate-pulse rounded bg-muted"
            style={{ opacity: 1 - index * 0.12 }}
          />
        ))}
      </div>
    </div>
  );
}
