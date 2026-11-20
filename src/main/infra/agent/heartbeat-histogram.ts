/**
 * The log line for one minute of heartbeat arrivals, or null when none was
 * late. Bucket 0 holds the on-time beats, bucket n those n slots late (the
 * last bucket, that many or more). A minute of on-time beats says nothing a
 * missing line does not, so it is not written.
 */
export function heartbeatHistogramLine(
  intervalMs: number,
  histogram: readonly number[],
): string | null {
  const total = histogram.reduce((a, b) => a + b, 0);
  const late = total - (histogram[0] ?? 0);
  if (total === 0 || late === 0) return null;
  const last = histogram.length - 1;
  const buckets = histogram
    .map((n, i) => `[${i === last ? `${i}+` : `${i}-${i + 1}`}x]:${n}`)
    .join(" ");
  return `heartbeat late (interval=${intervalMs}ms, total=${total}, late=${late}): ${buckets}`;
}
